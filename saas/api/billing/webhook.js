const crypto = require("crypto");
const { sql, initDB } = require("../_db");

const PLANS = {
  starter:    { price: 6,   credits_monthly: 5000,   daily: 200  },
  pro:        { price: 20,  credits_monthly: 20000,  daily: 200  },
  business:   { price: 100, credits_monthly: 100000, daily: 1000 },
  enterprise: { price: 200, credits_monthly: 200000, daily: 2000 },
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  // Flutterwave can send GET (redirect) or POST (webhook)
  const isWebhook = req.method === "POST";
  const isRedirect = req.method === "GET";

  if (!isWebhook && !isRedirect) {
    return res.status(405).json({ error: "POST or GET only" });
  }

  await initDB();
  const secretHash = process.env.FLUTTERWAVE_WEBHOOK_SECRET || "";

  let userId, planId, txId, flwRef;

  if (isWebhook) {
    // Verify webhook signature
    if (secretHash) {
      const signature = req.headers["verif-hash"] || "";
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      const hash = crypto.createHmac("sha256", secretHash).update(rawBody).digest("hex");
      if (signature !== hash) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    const event = req.body;
    if (event?.event !== "charge.completed" || event?.data?.status !== "successful") {
      return res.status(200).json({ ok: true, message: "Ignored" });
    }

    const data = event.data;
    const meta = data.meta || {};
    userId = meta.user_id;
    planId = meta.plan_id;
    txId = meta.transaction_id;
    flwRef = data.flw_ref;
  }

  if (isRedirect) {
    // Redirect from Flutterwave — verify transaction via API
    const { tx_ref, status, transaction_id: flwTxId } = req.query;
    if (!tx_ref) return res.status(400).send("Missing tx_ref");

    const flwKey = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!flwKey) return res.status(500).send("Server error");

    // Verify the transaction
    try {
      const verifyResp = await fetch(`https://api.flutterwave.com/v3/transactions/${flwTxId}/verify`, {
        headers: { Authorization: `Bearer ${flwKey}` },
      });
      const verifyData = await verifyResp.json();
      if (verifyData.status !== "success" || verifyData.data?.status !== "successful") {
        return res.status(400).send("Payment not successful");
      }
      const meta = verifyData.data.meta || {};
      userId = meta.user_id;
      planId = meta.plan_id;
      txId = meta.transaction_id;
      flwRef = verifyData.data.flw_ref;
    } catch (e) {
      return res.status(500).send("Verification failed");
    }
  }

  if (!userId || !planId) {
    return isRedirect
      ? res.status(400).send("Missing payment metadata")
      : res.status(200).json({ ok: true, message: "No metadata" });
  }

  const plan = PLANS[planId];
  if (!plan) {
    return isRedirect
      ? res.status(400).send("Invalid plan")
      : res.status(200).json({ ok: true, message: "Invalid plan" });
  }

  // Activate subscription
  await sql`
    INSERT INTO subscriptions (user_id, plan, status, credits_monthly, credits_daily_bonus, price_usd, flutterwave_sub_id, ends_at)
    VALUES (${userId}::uuid, ${planId}, 'active', ${plan.credits_monthly}, ${plan.daily}, ${plan.price}, ${flwRef || ''}, NOW() + INTERVAL '30 days')
    ON CONFLICT DO NOTHING
  `;

  // Allocate credits
  const existing = await sql`SELECT id FROM credits WHERE user_id = ${userId}::uuid`;
  if (existing.length === 0) {
    await sql`
      INSERT INTO credits (user_id, balance, total_allocated, total_used, daily_bonus_amount, last_daily_claim)
      VALUES (${userId}::uuid, ${plan.credits_monthly}, ${plan.credits_monthly}, 0, ${plan.daily}, NULL)
    `;
  } else {
    await sql`
      UPDATE credits SET
        balance = balance + ${plan.credits_monthly},
        total_allocated = total_allocated + ${plan.credits_monthly},
        daily_bonus_amount = ${plan.daily},
        updated_at = NOW()
      WHERE user_id = ${userId}::uuid
    `;
  }

  // Mark transaction complete
  if (txId) {
    await sql`
      UPDATE transactions SET status = 'completed', flutterwave_ref = ${flwRef || ''}, created_at = NOW()
      WHERE id = ${txId}::uuid
    `;
  }

  if (isRedirect) {
    // Redirect back to app
    return res.redirect(302, "taskbolt://billing/success?plan=" + planId);
  }

  return res.status(200).json({ ok: true, message: "Subscription activated" });
};
