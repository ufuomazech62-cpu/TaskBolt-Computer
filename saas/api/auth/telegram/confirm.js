const { sql, initDB } = require("../../_db");
const { jsonResponse, setCorsHeaders } = require("../../_auth");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { setCorsHeaders(res); return res.status(200).end(); }
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);
  await initDB();
  const { token, telegram_id, username, first_name } = req.body;
  if (!token || !telegram_id) return jsonResponse(res, { error: "Token and telegram_id required" }, 400);
  await sql`UPDATE telegram_logins SET telegram_id = ${telegram_id}, username = ${username || null}, first_name = ${first_name || null} WHERE token = ${token} AND expires_at > NOW()`;
  return jsonResponse(res, { ok: true });
};
