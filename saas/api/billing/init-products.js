const { jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

const DODO_API = "https://live.dodopayments.com";

// Credit packs definition (must match packs.js)
const PACKS = [
  { id: "starter",  name: "TaskBolt Starter — 1,000 Credits",   price_cents: 500,   credits: 1000,  description: "200K tokens — Light usage. One-time credit pack for TaskBolt AI Desktop Agent." },
  { id: "basic",    name: "TaskBolt Basic — 4,000 Credits",     price_cents: 1500,  credits: 4000,  description: "800K tokens — Regular use. One-time credit pack for TaskBolt AI Desktop Agent." },
  { id: "standard", name: "TaskBolt Standard — 10,000 Credits", price_cents: 3000,  credits: 10000, description: "2M tokens — Power users. One-time credit pack for TaskBolt AI Desktop Agent." },
  { id: "pro",      name: "TaskBolt Pro — 30,000 Credits",      price_cents: 7500,  credits: 30000, description: "6M tokens — Heavy workloads. One-time credit pack for TaskBolt AI Desktop Agent." },
  { id: "business", name: "TaskBolt Business — 70,000 Credits",  price_cents: 15000, credits: 70000, description: "14M tokens — Teams & enterprise. One-time credit pack for TaskBolt AI Desktop Agent." },
];

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  // This endpoint requires server-to-server call (no user auth needed — uses API key)
  const authHeader = req.headers["authorization"] || "";
  const adminSecret = process.env.ADMIN_SECRET || "taskbolt-admin-2026";
  if (authHeader !== `Bearer ${adminSecret}`) {
    // Also accept DODO_PAYMENTS_API_KEY as auth for simplicity
    const dodoKey = process.env.DODO_PAYMENTS_API_KEY || "";
    if (authHeader !== `Bearer ${dodoKey}`) {
      return jsonResponse(res, { error: "Unauthorized — provide ADMIN_SECRET or DODO_PAYMENTS_API_KEY" }, 401);
    }
  }

  const dodoKey = process.env.DODO_PAYMENTS_API_KEY;
  if (!dodoKey) return jsonResponse(res, { error: "DODO_PAYMENTS_API_KEY not configured" }, 500);

  await initDB();

  // Ensure dodo_products table exists
  await sql`CREATE TABLE IF NOT EXISTS dodo_products (
    pack_id TEXT PRIMARY KEY,
    dodo_product_id TEXT NOT NULL,
    name TEXT,
    price_cents INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
  )`;

  const results = [];

  for (const pack of PACKS) {
    // Check if product already exists
    const existing = await sql`SELECT dodo_product_id FROM dodo_products WHERE pack_id = ${pack.id}`;
    if (existing.length) {
      results.push({ pack_id: pack.id, dodo_product_id: existing[0].dodo_product_id, status: "already_exists" });
      continue;
    }

    // Create product in Dodo Payments
    try {
      const resp = await fetch(`${DODO_API}/products`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${dodoKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: pack.name,
          description: pack.description,
          tax_category: "digital_products",
          price: {
            currency: "USD",
            discount: 0,
            price: pack.price_cents,
            purchasing_power_parity: false,
            type: "one_time_price",
          },
          metadata: {
            pack_id: pack.id,
            credits: pack.credits.toString(),
            source: "taskbolt-auto-setup",
          },
        }),
      });

      const data = await resp.json();

      if (data.product_id || data.id) {
        const productId = data.product_id || data.id;
        await sql`
          INSERT INTO dodo_products (pack_id, dodo_product_id, name, price_cents)
          VALUES (${pack.id}, ${productId}, ${pack.name}, ${pack.price_cents})
          ON CONFLICT (pack_id) DO UPDATE SET dodo_product_id = ${productId}
        `;
        results.push({ pack_id: pack.id, dodo_product_id: productId, status: "created" });
      } else {
        console.error(`Failed to create product for ${pack.id}:`, JSON.stringify(data));
        results.push({ pack_id: pack.id, error: data.message || "Unknown error", status: "failed" });
      }
    } catch (e) {
      console.error(`Error creating product for ${pack.id}:`, e.message);
      results.push({ pack_id: pack.id, error: e.message, status: "error" });
    }
  }

  const allCreated = results.every(r => r.status === "created" || r.status === "already_exists");
  return jsonResponse(res, {
    ok: allCreated,
    results,
    message: allCreated ? "All products ready" : "Some products failed — check results",
  });
};
