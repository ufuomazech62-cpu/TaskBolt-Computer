const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  if (req.method === "GET") {
    const rows = await sql`
      SELECT id, email, username, display_name, avatar_url, telegram_id, google_id, github_id, created_at
      FROM users WHERE id = ${user.id}::uuid
    `;
    if (!rows[0]) return jsonResponse(res, { error: "User not found" }, 404);
    return jsonResponse(res, { ok: true, user: rows[0] });
  }

  if (req.method === "PATCH" || req.method === "PUT") {
    const { display_name, username } = req.body || {};
    const updates = [];
    const values = [];

    if (display_name !== undefined) {
      updates.push(`display_name = $${updates.length + 1}`);
      values.push(display_name);
    }
    if (username !== undefined) {
      updates.push(`username = $${updates.length + 1}`);
      values.push(username);
    }

    if (updates.length === 0) {
      return jsonResponse(res, { error: "No fields to update" }, 400);
    }

    values.push(user.id);
    await sql.unsafe(
      `UPDATE users SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${values.length}`,
      values
    );

    return jsonResponse(res, { ok: true, message: "Profile updated" });
  }

  return jsonResponse(res, { error: "Method not allowed" }, 405);
};
