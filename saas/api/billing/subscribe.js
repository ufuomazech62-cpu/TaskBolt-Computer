const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

const PAYSTACK_BASE = "https://api.paystack.co";

// Plan pricing in NGN (kobo = smallest unit, multiply by 100)
const PLANS = {
  starter:    { price_usd: 6,   price_ngn: 9900,    credits_monthly: 5000,   daily: 0    },
  pro:        { price_usd: 20,  price_ngn: 33000,   credits_monthly: 20000,  daily: 200  },
  business:   { price_usd: 100, price_ngn: 165000,  credits_monthly: 100000, daily: 1000 },
  enterprise: { price_usd: 200, price_ngn: 330000,  credits_monthly: 200000, daily: 2000 },
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  const { plan_id, email } = req.body;
  const plan = PLANS[plan_id];
  if (!plan) return jsonResponse(res, { error: "Invalid plan" }, 400);

  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) return jsonResponse(res, { error: "Payment system not configured" }, 500);

  // Cancel any existing active subscription
  await sql`
    UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
    WHERE user_id = ${user.id}::uuid AND status = 'active'
  `;

  // Create pending transaction record
  const tx = await sql`
    INSERT INTO transactions (user_id, type, plan, amount_usd, credits, status)
    VALUES (${user.id}::uuid, 'subscription', ${plan_id}, ${plan.price_usd}, ${plan.credits_monthly}, 'pending')
    RETURNING id
  `;

  // Build Paystack initialization payload
  const reference = `tb-${user.id}-${Date.now()}`;
  const amountInKobo = plan.price_ngn * 100; // Paystack uses kobo

  const payload = {
    email: email || user.email || "user@taskbolt.com",
    amount: amountInKobo,
    currency: "NGN",
    reference: reference,
    callback_url: "https://taskbolt-saas.vercel.app/api/billing/callback",
    metadata: {
      user_id: user.id,
      plan_id: plan_id,
      transaction_id: tx[0].id,
      custom_fields: [
        { display_name: "Plan", variable_name: "plan", value: plan_id },
        { display_name: "Credits", variable_name: "credits", value: plan.credits_monthly.toString() },
      ],
    },
  };

  try {
    const resp = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${paystackKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();

    if (!data.status || !data.data?.authorization_url) {
      await sql`UPDATE transactions SET status = 'failed' WHERE id = ${tx[0].id}::uuid`;
      return jsonResponse(res, { error: data.message || "Payment initialization failed" }, 400);
    }

    return jsonResponse(res, {
      ok: true,
      payment_url: data.data.authorization_url,
      reference: reference,
      access_code: data.data.access_code,
      plan: plan_id,
      amount_ngn: plan.price_ngn,
      amount_usd: plan.price_usd,
    });
  } catch (e) {
    await sql`UPDATE transactions SET status = 'error', metadata = ${JSON.stringify({ error: e.message })}::jsonb WHERE id = ${tx[0].id}::uuid`;
    return jsonResponse(res, { error: "Payment service unavailable" }, 502);
  }
};
