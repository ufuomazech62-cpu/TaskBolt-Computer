const { requireAuth, jsonResponse } = require("../_auth");

// Rate: $1 USD = 1650 NGN
// 1 credit = 200 tokens
const USD_TO_NGN = 1650;

const PLANS = [
  {
    id: "starter",
    name: "Starter",
    price_usd: 6,
    price_ngn: 9900,
    credits_monthly: 5000,
    credits_daily_bonus: 0,
    tokens_monthly: 1000000,
    description: "1M tokens/month",
    features: ["1M tokens/month", "All AI models", "Email support"]
  },
  {
    id: "pro",
    name: "Pro",
    price_usd: 20,
    price_ngn: 33000,
    credits_monthly: 20000,
    credits_daily_bonus: 200,
    tokens_monthly: 4000000,
    description: "4M tokens/month + 200 daily bonus",
    features: ["4M tokens/month", "200 daily bonus credits", "All AI models", "Priority support"]
  },
  {
    id: "business",
    name: "Business",
    price_usd: 100,
    price_ngn: 165000,
    credits_monthly: 100000,
    credits_daily_bonus: 1000,
    tokens_monthly: 20000000,
    description: "20M tokens/month + 1,000 daily bonus",
    features: ["20M tokens/month", "1,000 daily bonus credits", "All AI models", "Priority support", "Advanced tools"]
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price_usd: 200,
    price_ngn: 330000,
    credits_monthly: 200000,
    credits_daily_bonus: 2000,
    tokens_monthly: 40000000,
    description: "40M tokens/month + 2,000 daily bonus",
    features: ["40M tokens/month", "2,000 daily bonus credits", "All AI models", "Dedicated support", "Custom integrations"]
  }
];

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return jsonResponse(res, { error: "GET only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  return jsonResponse(res, { ok: true, plans: PLANS, rate: USD_TO_NGN });
};
