const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "DELETE" && req.method !== "POST") {
    return jsonResponse(res, { error: "DELETE or POST only" }, 405);
  }

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  // Verify confirmation
  const { confirm } = req.body || {};
  if (confirm !== "DELETE") {
    return jsonResponse(res, { error: "Must send { confirm: \"DELETE\" } to proceed" }, 400);
  }

  // Cancel active subscriptions
  await sql`
    UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
    WHERE user_id = ${user.id}::uuid AND status = 'active'
  `;

  // Delete all user data (CASCADE handles related tables)
  await sql`DELETE FROM users WHERE id = ${user.id}::uuid`;

  return jsonResponse(res, {
    ok: true,
    message: "Account and all data permanently deleted",
  });
};
