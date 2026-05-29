const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

const FLW_BASE = "https://api.flutterwave.com/v3";
const PLANS = {
  starter:    { price: 6,   credits_monthly: 5000,   daily: 200  },
  pro:        { price: 20,  credits_monthly: 20000,  daily: 200  },
  business:   { price: 100, credits_monthly: 100000, daily: 1000 },
  enterprise: { price: 200, credits_monthly: 200000, daily: 2000 },
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  const { plan_id, email, name, redirect_url } = req.body;
  const plan = PLANS[plan_id];
  if (!plan) return jsonResponse(res, { error: "Invalid plan" }, 400);

  const flwKey = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!flwKey) return jsonResponse(res, { error: "Payment system not configured" }, 500);

  // Cancel any existing active subscription first
  await sql`
    UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
    WHERE user_id = ${user.id}::uuid AND status = 'active'
  `;

  // Create transaction record
  const tx = await sql`
    INSERT INTO transactions (user_id, type, plan, amount_usd, credits, status)
    VALUES (${user.id}::uuid, 'subscription', ${plan_id}, ${plan.price}, ${plan.credits_monthly}, 'pending')
    RETURNING id
  `;

  // Build Flutterwave payment link
  const txRef = `tb-sub-${user.id}-${Date.now()}`;
  const callbackUrl = redirect_url || "https://taskbolt-saas.vercel.app/api/billing/webhook";

  const payload = {
    tx_ref: txRef,
    amount: plan.price,
    currency: "USD",
    payment_options: "card,banktransfer",
    redirect_url: callbackUrl,
    customer: {
      email: email || user.email || "user@taskbolt.com",
      name: name || user.display_name || "TaskBolt User",
    },
    customizations: {
      title: `TaskBolt ${plan_id.charAt(0).toUpperCase() + plan_id.slice(1)} Plan`,
      description: `${plan.credits_monthly.toLocaleString()} credits/month + ${plan.daily} daily bonus`,
    },
    meta: {
      user_id: user.id,
      plan_id: plan_id,
      transaction_id: tx[0].id,
    },
  };

  try {
    const resp = await fetch(`${FLW_BASE}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${flwKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();

    if (data.status !== "success" || !data.data?.link) {
      // Update transaction as failed
      await sql`UPDATE transactions SET status = 'failed' WHERE id = ${tx[0].id}::uuid`;
      return jsonResponse(res, { error: data.message || "Payment initiation failed" }, 400);
    }

    return jsonResponse(res, {
      ok: true,
      payment_url: data.data.link,
      tx_ref: txRef,
      plan: plan_id,
      amount: plan.price,
    });
  } catch (e) {
    await sql`UPDATE transactions SET status = 'error', metadata = ${JSON.stringify({ error: e.message })}::jsonb WHERE id = ${tx[0].id}::uuid`;
    return jsonResponse(res, { error: "Payment service unavailable" }, 502);
  }
};
