const { sql, initDB } = require("../../_db");
const { jsonResponse, setCorsHeaders } = require("../../_auth");
const crypto = require("crypto");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { setCorsHeaders(res); return res.status(200).end(); }
  await initDB();
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await sql`INSERT INTO telegram_logins (token, expires_at) VALUES (${token}, ${expiresAt.toISOString()})`;
  const deeplink = `https://t.me/TaskBoltBot?start=login_${token}`;
  return jsonResponse(res, { ok: true, token, deeplink, expires_in: 300 });
};
