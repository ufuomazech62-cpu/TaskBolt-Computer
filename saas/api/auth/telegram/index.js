const { sql, initDB } = require("../../../lib/_db");
const { sign } = require("../../../lib/_jwt");
const { jsonResponse, setCorsHeaders } = require("../../../lib/_auth");
const crypto = require("crypto");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { setCorsHeaders(res); return res.status(200).end(); }
  await initDB();

  const action = req.query.action || "qr";

  // --- QR (GET ?action=qr) ---
  if (action === "qr" && req.method === "GET") {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await sql`INSERT INTO telegram_logins (token, expires_at) VALUES (${token}, ${expiresAt.toISOString()})`;
    const deeplink = `https://t.me/TaskBoltBot?start=login_${token}`;
    return jsonResponse(res, { ok: true, token, deeplink, expires_in: 300 });
  }

  // --- CHECK (GET ?action=check&token=xxx) ---
  if (action === "check" && req.method === "GET") {
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
  }

  // --- CONFIRM (POST ?action=confirm) ---
  if (action === "confirm" && req.method === "POST") {
    const { token, telegram_id, username, first_name } = req.body;
    if (!token || !telegram_id) return jsonResponse(res, { error: "Token and telegram_id required" }, 400);
    await sql`UPDATE telegram_logins SET telegram_id = ${telegram_id}, username = ${username || null}, first_name = ${first_name || null} WHERE token = ${token} AND expires_at > NOW()`;
    return jsonResponse(res, { ok: true });
  }

  return jsonResponse(res, { error: "Unknown action. Use: qr, check, or confirm" }, 400);
};
