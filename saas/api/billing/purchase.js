const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

const PAYSTACK_BASE = "https://api.paystack.co";

const PACKS = {
  starter:  { price_ngn: 1500,  credits: 1000  },
  basic:    { price_ngn: 5000,  credits: 4000  },
  standard: { price_ngn: 10000, credits: 10000 },
  pro:      { price_ngn: 25000, credits: 30000 },
  business: { price_ngn: 50000, credits: 70000 },
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  const { pack_id, email } = req.body;
  const pack = PACKS[pack_id];
  if (!pack) return jsonResponse(res, { error: "Invalid pack" }, 400);

  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) return jsonResponse(res, { error: "Payment system not configured" }, 500);

  // Create pending transaction
  const tx = await sql`
    INSERT INTO transactions (user_id, type, credits, status)
    VALUES (${user.id}::uuid, 'purchase', ${pack.credits}, 'pending')
    RETURNING id
  `;

  // Initialize Paystack transaction
  const reference = `tb-${user.id}-${Date.now()}`;
  const amountInKobo = pack.price_ngn * 100;

  const payload = {
    email: email || user.email || "user@taskbolt.com",
    amount: amountInKobo,
    currency: "NGN",
    reference: reference,
    callback_url: "https://taskbolt-saas.vercel.app/api/billing/callback",
    metadata: {
      user_id: user.id,
      pack_id: pack_id,
      transaction_id: tx[0].id,
      credits: pack.credits,
      custom_fields: [
        { display_name: "Pack", variable_name: "pack", value: pack_id },
        { display_name: "Credits", variable_name: "credits", value: pack.credits.toString() },
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
      pack: pack_id,
      credits: pack.credits,
      amount_ngn: pack.price_ngn,
    });
  } catch (e) {
    await sql`UPDATE transactions SET status = 'error', metadata = ${JSON.stringify({ error: e.message })}::jsonb WHERE id = ${tx[0].id}::uuid`;
    return jsonResponse(res, { error: "Payment service unavailable" }, 502);
  }
};
