const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return jsonResponse(res, { error: "GET only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  const { period = "month" } = req.query;

  let dateFilter;
  if (period === "today") {
    dateFilter = sql`created_at >= CURRENT_DATE`;
  } else if (period === "week") {
    dateFilter = sql`created_at >= CURRENT_DATE - INTERVAL '7 days'`;
  } else {
    dateFilter = sql`created_at >= DATE_TRUNC('month', CURRENT_DATE)`;
  }

  // Aggregate stats
  const stats = await sql`
    SELECT
      COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as completion_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(credits_deducted), 0) as credits_used,
      COUNT(*) as requests
    FROM usage_logs
    WHERE user_id = ${user.id}::uuid AND ${dateFilter}
  `;

  // Daily breakdown (last 30 days)
  const daily = await sql`
    SELECT
      DATE(created_at) as date,
      SUM(total_tokens) as tokens,
      SUM(credits_deducted) as credits,
      COUNT(*) as requests
    FROM usage_logs
    WHERE user_id = ${user.id}::uuid AND created_at >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `;

  // Model breakdown
  const models = await sql`
    SELECT
      model,
      SUM(total_tokens) as tokens,
      SUM(credits_deducted) as credits,
      COUNT(*) as requests
    FROM usage_logs
    WHERE user_id = ${user.id}::uuid AND ${dateFilter}
    GROUP BY model
    ORDER BY tokens DESC
  `;

  // Recent transactions
  const transactions = await sql`
    SELECT type, plan, amount_usd, credits, status, created_at
    FROM transactions
    WHERE user_id = ${user.id}::uuid
    ORDER BY created_at DESC LIMIT 20
  `;

  return jsonResponse(res, {
    ok: true,
    period,
    stats: {
      prompt_tokens: Number(stats[0]?.prompt_tokens || 0),
      completion_tokens: Number(stats[0]?.completion_tokens || 0),
      total_tokens: Number(stats[0]?.total_tokens || 0),
      credits_used: Number(stats[0]?.credits_used || 0),
      requests: Number(stats[0]?.requests || 0),
    },
    daily: daily.map(d => ({
      date: d.date,
      tokens: Number(d.tokens),
      credits: Number(d.credits),
      requests: Number(d.requests),
    })),
    models: models.map(m => ({
      model: m.model,
      tokens: Number(m.tokens),
      credits: Number(m.credits),
      requests: Number(m.requests),
    })),
    transactions: transactions.map(t => ({
      type: t.type,
      plan: t.plan,
      amount_usd: t.amount_usd ? Number(t.amount_usd) : null,
      credits: t.credits,
      status: t.status,
      created_at: t.created_at,
    })),
  });
};
