const { requireAuth, jsonResponse } = require("../_auth");

// Credit math: 1 credit = 200 tokens (1M tokens = 5,000 credits)
const PLANS = [
  {
    id: "starter",
    name: "Starter",
    price_usd: 6,
    credits_monthly: 5000,
    credits_daily_bonus: 200,
    tokens_monthly: 1000000,
    description: "1M tokens/month + 200 daily bonus",
    features: ["1M tokens/month", "200 daily bonus credits", "All AI models", "Priority support"]
  },
  {
    id: "pro",
    name: "Pro",
    price_usd: 20,
    credits_monthly: 20000,
    credits_daily_bonus: 200,
    tokens_monthly: 4000000,
    description: "4M tokens/month + 200 daily bonus",
    features: ["4M tokens/month", "200 daily bonus credits", "All AI models", "Priority support", "Advanced tools"]
  },
  {
    id: "business",
    name: "Business",
    price_usd: 100,
    credits_monthly: 100000,
    credits_daily_bonus: 1000,
    tokens_monthly: 20000000,
    description: "20M tokens/month + 1,000 daily bonus",
    features: ["20M tokens/month", "1,000 daily bonus credits", "All AI models", "Priority support", "Advanced tools", "Team features"]
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price_usd: 200,
    credits_monthly: 200000,
    credits_daily_bonus: 2000,
    tokens_monthly: 40000000,
    description: "40M tokens/month + 2,000 daily bonus",
    features: ["40M tokens/month", "2,000 daily bonus credits", "All AI models", "Priority support", "Advanced tools", "Custom integrations", "Dedicated support"]
  }
];

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return jsonResponse(res, { error: "GET only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  return jsonResponse(res, { ok: true, plans: PLANS });
};
