const { sql, initDB } = require("../../_db");
const { sign } = require("../../_jwt");
const { jsonResponse, setCorsHeaders } = require("../../_auth");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { setCorsHeaders(res); return res.status(200).end(); }
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);
  
  await initDB();
  const { email, code } = req.body;
  const cleanEmail = (email || "").toLowerCase().trim();
  const cleanCode = (code || "").trim();
  
  if (!cleanEmail || !cleanCode) return jsonResponse(res, { error: "Email and code required" }, 400);

  const codes = await sql`SELECT * FROM auth_codes WHERE email = ${cleanEmail} AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`;
  
  if (codes.length === 0 || codes[0].code !== cleanCode) {
    return jsonResponse(res, { ok: false, error: "Invalid or expired code. Try again." }, 400);
  }

  await sql`DELETE FROM auth_codes WHERE email = ${cleanEmail}`;

  let user = await sql`SELECT * FROM users WHERE email = ${cleanEmail} LIMIT 1`;
  if (user.length === 0) {
    user = await sql`INSERT INTO users (email, display_name) VALUES (${cleanEmail}, ${cleanEmail.split("@")[0]}) RETURNING *`;
  }
  user = user[0];
  
  const token = sign({ userId: user.id, email: user.email });
  return jsonResponse(res, { ok: true, token, user });
};
