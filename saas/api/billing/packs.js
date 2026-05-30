const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

// Credit packs — one-time purchase via Dodo Payments
// 1 credit = 200 tokens
// Prices in USD (cents for Dodo API)
const PACKS = [
  { id: "starter",  name: "Starter",  price_usd: 5,   price_cents: 500,   credits: 1000,  tokens: 200000,  description: "200K tokens — Light usage" },
  { id: "basic",    name: "Basic",    price_usd: 15,  price_cents: 1500,  credits: 4000,  tokens: 800000,  description: "800K tokens — Regular use" },
  { id: "standard", name: "Standard", price_usd: 30,  price_cents: 3000,  credits: 10000, tokens: 2000000, description: "2M tokens — Power users" },
  { id: "pro",      name: "Pro",      price_usd: 75,  price_cents: 7500,  credits: 30000, tokens: 6000000, description: "6M tokens — Heavy workloads" },
  { id: "business", name: "Business", price_usd: 150, price_cents: 15000, credits: 70000, tokens: 14000000, description: "14M tokens — Teams & enterprise" },
];

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return jsonResponse(res, { error: "GET only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  // Fetch Dodo product IDs from DB
  await initDB();
  const dodoProducts = await sql`SELECT pack_id, dodo_product_id FROM dodo_products`;
  const productMap = {};
  dodoProducts.forEach(p => { productMap[p.pack_id] = p.dodo_product_id; });

  // Enrich packs with Dodo product IDs
  const packs = PACKS.map(p => ({
    id: p.id,
    name: p.name,
    price_usd: p.price_usd,
    credits: p.credits,
    tokens: p.tokens,
    description: p.description,
    dodo_product_id: productMap[p.id] || null,
    available: !!productMap[p.id],
  }));

  return jsonResponse(res, { ok: true, packs });
};

// Export for use by other modules
module.exports.PACKS = PACKS;
