const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

const DODO_API = "https://live.dodopayments.com";
const SAAS_URL = "https://taskbolt-saas.vercel.app";

const PACKS = {
  starter:  { price_cents: 500,   credits: 1000  },
  basic:    { price_cents: 1500,  credits: 4000  },
  standard: { price_cents: 3000,  credits: 10000 },
  pro:      { price_cents: 7500,  credits: 30000 },
  business: { price_cents: 15000, credits: 70000 },
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  const { pack_id } = req.body;
  const pack = PACKS[pack_id];
  if (!pack) return jsonResponse(res, { error: "Invalid pack" }, 400);

  const dodoKey = process.env.DODO_PAYMENTS_API_KEY;
  if (!dodoKey) return jsonResponse(res, { error: "Payment system not configured" }, 500);

  // Get Dodo product ID from DB
  const prod = await sql`SELECT dodo_product_id FROM dodo_products WHERE pack_id = ${pack_id}`;
  if (!prod.length || !prod[0].dodo_product_id) {
    return jsonResponse(res, { error: "Pack not available. Please contact support." }, 400);
  }
  const dodoProductId = prod[0].dodo_product_id;

  // Create pending transaction in our DB
  const tx = await sql`
    INSERT INTO transactions (user_id, type, credits, amount_ngn, status, metadata)
    VALUES (${user.id}::uuid, 'purchase', ${pack.credits}, ${pack.price_cents / 100}, 'pending', ${JSON.stringify({ pack_id, provider: 'dodo' })}::jsonb)
    RETURNING id
  `;
  const txId = tx[0].id;

  // Create Dodo checkout session
  const checkoutPayload = {
    product_cart: [
      {
        product_id: dodoProductId,
        quantity: 1,
      }
    ],
    customer: {
      email: user.email || "user@taskbolt.com",
    },
    returnURL: `${SAAS_URL}/api/billing/callback?tx=${txId}&pack=${pack_id}&credits=${pack.credits}`,
    cancelURL: `${SAAS_URL}/api/billing/callback?cancelled=true`,
    metadata: {
      user_id: user.id,
      pack_id: pack_id,
      transaction_id: txId,
      credits: pack.credits.toString(),
    },
    // Minimal checkout — no address, no phone, no name editing
    minimalAddress: true,
    featureFlags: {
      allowPhoneNumberCollection: false,
      requirePhoneNumber: false,
      allowCustomerEditingCity: false,
      allowCustomerEditingStreet: false,
      allowCustomerEditingZipcode: false,
      allowCustomerEditingCountry: false,
      allowCustomerEditingState: false,
      allowCustomerEditingName: false,
      allowCustomerEditingEmail: false,
      allowCustomerEditingBusinessName: false,
      allowCustomerEditingTaxID: false,
    },
  };

  try {
    const resp = await fetch(`${DODO_API}/checkouts`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${dodoKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(checkoutPayload),
    });

    const data = await resp.json();

    if (!data.session_id || !data.checkout_url) {
      console.error("Dodo checkout failed:", JSON.stringify(data));
      await sql`UPDATE transactions SET status = 'failed', metadata = ${JSON.stringify({ error: data.message || "Checkout creation failed", response: data })}::jsonb WHERE id = ${txId}::uuid`;
      return jsonResponse(res, { error: data.message || "Payment initialization failed" }, 400);
    }

    return jsonResponse(res, {
      ok: true,
      payment_url: data.checkout_url,
      session_id: data.session_id,
      pack: pack_id,
      credits: pack.credits,
      amount_usd: pack.price_cents / 100,
    });
  } catch (e) {
    console.error("Dodo checkout error:", e.message);
    await sql`UPDATE transactions SET status = 'error', metadata = ${JSON.stringify({ error: e.message })}::jsonb WHERE id = ${txId}::uuid`;
    return jsonResponse(res, { error: "Payment service unavailable" }, 502);
  }
};
