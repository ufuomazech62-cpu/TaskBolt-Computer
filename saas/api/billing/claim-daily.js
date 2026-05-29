const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  // Check active subscription
  const subs = await sql`
    SELECT plan, credits_daily_bonus FROM subscriptions
    WHERE user_id = ${user.id}::uuid AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `;

  if (!subs[0]) {
    return jsonResponse(res, { error: "No active subscription" }, 403);
  }

  const dailyAmount = subs[0].credits_daily_bonus;
  const today = new Date().toISOString().split("T")[0];

  // Check if already claimed today
  const cred = await sql`SELECT last_daily_claim FROM credits WHERE user_id = ${user.id}::uuid`;
  if (cred[0]?.last_daily_claim === today) {
    return jsonResponse(res, { error: "Already claimed today", claimed: true }, 409);
  }

  // Claim daily bonus
  if (cred.length === 0) {
    await sql`
      INSERT INTO credits (user_id, balance, total_allocated, total_used, daily_bonus_amount, last_daily_claim)
      VALUES (${user.id}::uuid, ${dailyAmount}, ${dailyAmount}, 0, ${dailyAmount}, ${today}::date)
    `;
  } else {
    await sql`
      UPDATE credits SET
        balance = balance + ${dailyAmount},
        total_allocated = total_allocated + ${dailyAmount},
        last_daily_claim = ${today}::date,
        updated_at = NOW()
      WHERE user_id = ${user.id}::uuid
    `;
  }

  // Log transaction
  await sql`
    INSERT INTO transactions (user_id, type, credits, status)
    VALUES (${user.id}::uuid, 'daily_bonus', ${dailyAmount}, 'completed')
  `;

  return jsonResponse(res, {
    ok: true,
    claimed: dailyAmount,
    message: `+${dailyAmount.toLocaleString()} daily credits claimed`,
  });
};
