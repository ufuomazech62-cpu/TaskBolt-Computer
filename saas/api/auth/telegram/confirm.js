const { sql, initDB } = require("../../_db");
const { jsonResponse } = require("../../_auth");

async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: require("../../_auth").corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  await initDB();
  
  const body = await req.json();
  const { token, telegram_id, username, first_name } = body;
  if (!token || !telegram_id) return jsonResponse({ error: "Token and telegram_id required" }, 400);

  await sql`UPDATE telegram_logins SET telegram_id = ${telegram_id}, username = ${username || null}, first_name = ${first_name || null} WHERE token = ${token} AND expires_at > NOW()`;
  return jsonResponse({ ok: true });
}

module.exports = async (req) => handler(req);
