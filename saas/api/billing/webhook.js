const crypto = require("crypto");
const { sql, initDB } = require("../_db");

const PAYSTACK_BASE = "https://api.paystack.co";

const PLANS = {
  starter:    { price_usd: 6,   price_ngn: 9900,    credits_monthly: 5000,   daily: 0    },
  pro:        { price_usd: 20,  price_ngn: 33000,   credits_monthly: 20000,  daily: 200  },
  business:   { price_usd: 100, price_ngn: 165000,  credits_monthly: 100000, daily: 1000 },
  enterprise: { price_usd: 200, price_ngn: 330000,  credits_monthly: 200000, daily: 2000 },
};

async function activateSubscription(userId, planId, flwRef) {
  const plan = PLANS[planId];
  if (!plan) return false;

  // Activate subscription
  await sql`
    INSERT INTO subscriptions (user_id, plan, status, credits_monthly, credits_daily_bonus, price_usd, flutterwave_sub_id, ends_at)
    VALUES (${userId}::uuid, ${planId}, 'active', ${plan.credits_monthly}, ${plan.daily}, ${plan.price_usd}, ${flwRef || ''}, NOW() + INTERVAL '30 days')
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

  return true;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  await initDB();

  // Verify Paystack webhook signature
  const secret = process.env.PAYSTACK_SECRET_KEY || "";
  if (secret) {
    const signature = req.headers["x-paystack-signature"] || "";
    // Paystack sends raw body — we need to hash it
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
    if (signature !== hash) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  const event = req.body;

  // Only process charge.success events
  if (event?.event !== "charge.success") {
    return res.status(200).json({ ok: true, message: "Ignored non-success event" });
  }

  const data = event.data;
  const metadata = data.metadata || {};
  const userId = metadata.user_id;
  const planId = metadata.plan_id;
  const txId = metadata.transaction_id;
  const reference = data.reference;

  if (!userId || !planId) {
    return res.status(200).json({ ok: true, message: "No metadata" });
  }

  // Verify the transaction with Paystack API
  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (paystackKey) {
    try {
      const verifyResp = await fetch(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${paystackKey}` },
      });
      const verifyData = await verifyResp.json();
      if (!verifyData.status || verifyData.data?.status !== "success") {
        return res.status(200).json({ ok: true, message: "Verification failed" });
      }
    } catch {
      // Continue anyway — webhook signature already verified
    }
  }

  // Activate subscription
  const success = await activateSubscription(userId, planId, reference);

  // Mark transaction complete
  if (txId) {
    await sql`
      UPDATE transactions SET status = 'completed', flutterwave_ref = ${reference || ''}, created_at = NOW()
      WHERE id = ${txId}::uuid
    `;
  }

  return res.status(200).json({ ok: true, message: "Subscription activated" });
};
