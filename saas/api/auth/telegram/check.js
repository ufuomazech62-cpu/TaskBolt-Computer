const { sql, initDB } = require("../../_db");
const { sign } = require("../../_jwt");
const { jsonResponse, setCorsHeaders } = require("../../_auth");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { setCorsHeaders(res); return res.status(200).end(); }
  await initDB();
  const token = req.query.token;
  if (!token) return jsonResponse(res, { error: "Token required" }, 400);

  const logins = await sql`SELECT * FROM telegram_logins WHERE token = ${token} AND expires_at > NOW() LIMIT 1`;
  if (logins.length === 0) return jsonResponse(res, { ok: false, error: "Expired or invalid" }, 404);
  
  const login = logins[0];
  if (!login.telegram_id) return jsonResponse(res, { ok: false, pending: true, message: "Waiting..." });

  let user = await sql`SELECT * FROM users WHERE telegram_id = ${login.telegram_id} LIMIT 1`;
  if (user.length === 0) {
    user = await sql`INSERT INTO users (telegram_id, username, display_name) VALUES (${login.telegram_id}, ${login.username}, ${login.first_name || login.username || 'User'}) RETURNING *`;
  }
  user = user[0];
  await sql`DELETE FROM telegram_logins WHERE token = ${token}`;
  const jwt = sign({ userId: user.id, telegram_id: user.telegram_id });
  return jsonResponse(res, { ok: true, token: jwt, user });
};
