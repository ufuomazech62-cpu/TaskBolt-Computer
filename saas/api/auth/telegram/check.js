const { sql, initDB } = require("../../_db");
const { sign } = require("../../_jwt");
const { jsonResponse } = require("../../_auth");

async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: require("../../_auth").corsHeaders() });
  await initDB();
  
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return jsonResponse({ error: "Token required" }, 400);

  const logins = await sql`SELECT * FROM telegram_logins WHERE token = ${token} AND expires_at > NOW() LIMIT 1`;
  if (logins.length === 0) return jsonResponse({ ok: false, error: "Expired or invalid" }, 404);
  
  const login = logins[0];
  if (!login.telegram_id) return jsonResponse({ ok: false, pending: true, message: "Waiting for Telegram confirmation..." });

  // User confirmed via Telegram bot — find or create user
  let user = await sql`SELECT * FROM users WHERE telegram_id = ${login.telegram_id} LIMIT 1`;
  if (user.length === 0) {
    user = await sql`INSERT INTO users (telegram_id, username, display_name) VALUES (${login.telegram_id}, ${login.username}, ${login.first_name || login.username || 'User'}) RETURNING *`;
  }
  user = user[0];
  
  // Clean up login session
  await sql`DELETE FROM telegram_logins WHERE token = ${token}`;
  
  const jwt = sign({ userId: user.id, telegram_id: user.telegram_id });
  return jsonResponse({ ok: true, token: jwt, user });
}

module.exports = async (req) => handler(req);
