const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return jsonResponse(res, { error: "GET only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  // Get active subscription
  const subs = await sql`
    SELECT plan, status, credits_monthly, credits_daily_bonus, price_usd, starts_at, ends_at
    FROM subscriptions
    WHERE user_id = ${user.id}::uuid AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `;

  const subscription = subs[0] || null;

  // Get credits
  const cred = await sql`
    SELECT balance, total_allocated, total_used, daily_bonus_amount, last_daily_claim
    FROM credits WHERE user_id = ${user.id}::uuid
  `;
  const credits = cred[0] || { balance: 0, total_allocated: 0, total_used: 0, daily_bonus_amount: 0, last_daily_claim: null };

  // Check if daily claim available today
  const today = new Date().toISOString().split("T")[0];
  const canClaimDaily = credits.last_daily_claim !== today && credits.daily_bonus_amount > 0;

  // Today's usage
  const todayUsage = await sql`
    SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(credits_deducted), 0) as credits
    FROM usage_logs
    WHERE user_id = ${user.id}::uuid AND created_at >= CURRENT_DATE
  `;

  // This month's usage
  const monthUsage = await sql`
    SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(credits_deducted), 0) as credits
    FROM usage_logs
    WHERE user_id = ${user.id}::uuid AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
  `;

  return jsonResponse(res, {
    ok: true,
    subscription: subscription ? {
      plan: subscription.plan,
      status: subscription.status,
      price_usd: Number(subscription.price_usd),
      starts_at: subscription.starts_at,
      ends_at: subscription.ends_at,
      credits_monthly: subscription.credits_monthly,
      credits_daily_bonus: subscription.credits_daily_bonus,
    } : null,
    credits: {
      balance: credits.balance,
      total_allocated: credits.total_allocated,
      total_used: credits.total_used,
      daily_bonus_amount: credits.daily_bonus_amount,
      can_claim_daily: canClaimDaily,
    },
    usage: {
      today: {
        tokens: Number(todayUsage[0]?.tokens || 0),
        credits: Number(todayUsage[0]?.credits || 0),
      },
      this_month: {
        tokens: Number(monthUsage[0]?.tokens || 0),
        credits: Number(monthUsage[0]?.credits || 0),
      },
    },
  });
};
