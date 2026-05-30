const { requireAuth, jsonResponse } = require("../_auth");

// Credit packs — one-time purchase, no subscription
// 1 credit = 200 tokens
const PACKS = [
  { id: "starter",  name: "Starter",  price_ngn: 1500,  credits: 1000,  tokens: 200000,  description: "200K tokens — Light usage" },
  { id: "basic",    name: "Basic",    price_ngn: 5000,  credits: 4000,  tokens: 800000,  description: "800K tokens — Regular use" },
  { id: "standard", name: "Standard", price_ngn: 10000, credits: 10000, tokens: 2000000, description: "2M tokens — Power users" },
  { id: "pro",      name: "Pro",      price_ngn: 25000, credits: 30000, tokens: 6000000, description: "6M tokens — Heavy workloads" },
  { id: "business", name: "Business", price_ngn: 50000, credits: 70000, tokens: 14000000, description: "14M tokens — Teams & enterprise" },
];

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return jsonResponse(res, { error: "GET only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  return jsonResponse(res, { ok: true, packs: PACKS });
};
