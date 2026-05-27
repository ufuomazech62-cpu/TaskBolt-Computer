const { sql, initDB } = require("../../_db");
const { jsonResponse } = require("../../_auth");
const crypto = require("crypto");

async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: require("../../_auth").corsHeaders() });
  await initDB();

  // Create a new login session
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min
  await sql`INSERT INTO telegram_logins (token, expires_at) VALUES (${token}, ${expiresAt.toISOString()})`;

  // Return the token and deeplink
  const deeplink = `https://t.me/TaskBoltBot?start=login_${token}`;
  return jsonResponse({ ok: true, token, deeplink, expires_in: 300 });
}

module.exports = async (req) => handler(req);
