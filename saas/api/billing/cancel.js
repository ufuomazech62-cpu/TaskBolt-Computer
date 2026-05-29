const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  const result = await sql`
    UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
    WHERE user_id = ${user.id}::uuid AND status = 'active'
    RETURNING plan
  `;

  if (result.length === 0) {
    return jsonResponse(res, { error: "No active subscription" }, 404);
  }

  // Zero out daily bonus on cancellation
  await sql`
    UPDATE credits SET daily_bonus_amount = 0, updated_at = NOW()
    WHERE user_id = ${user.id}::uuid
  `;

  return jsonResponse(res, {
    ok: true,
    message: `Subscription cancelled. Remaining credits will be available until used.`,
    plan: result[0].plan,
  });
};
