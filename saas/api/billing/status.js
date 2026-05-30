const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return jsonResponse(res, { error: "GET only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  // Get credits
  const cred = await sql`SELECT balance, total_allocated, total_used FROM credits WHERE user_id = ${user.id}::uuid`;
  const credits = cred[0] || { balance: 0, total_allocated: 0, total_used: 0 };

  // Today's usage
  const todayUsage = await sql`
    SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(credits_deducted), 0) as credits
    FROM usage_logs WHERE user_id = ${user.id}::uuid AND created_at >= CURRENT_DATE
  `;

  // This month's usage
  const monthUsage = await sql`
    SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(credits_deducted), 0) as credits
    FROM usage_logs WHERE user_id = ${user.id}::uuid AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
  `;

  return jsonResponse(res, {
    ok: true,
    credits: {
      balance: credits.balance,
      total_allocated: credits.total_allocated,
      total_used: credits.total_used,
    },
    usage: {
      today: { tokens: Number(todayUsage[0]?.tokens || 0), credits: Number(todayUsage[0]?.credits || 0) },
      this_month: { tokens: Number(monthUsage[0]?.tokens || 0), credits: Number(monthUsage[0]?.credits || 0) },
    },
  });
};
