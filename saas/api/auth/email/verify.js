const { sql, initDB } = require("../../_db");
const { sign } = require("../../_jwt");
const { jsonResponse } = require("../../_auth");

async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: require("../../_auth").corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  
  await initDB();
  const body = await req.json();
  const email = body.email?.toLowerCase().trim();
  const code = body.code?.trim();
  
  if (!email || !code) return jsonResponse({ error: "Email and code required" }, 400);

  // Find valid code (no lockout — just check if it matches)
  const codes = await sql`SELECT * FROM auth_codes WHERE email = ${email} AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`;
  
  if (codes.length === 0 || codes[0].code !== code) {
    return jsonResponse({ ok: false, error: "Invalid or expired code. Try again." }, 400);
  }

  // Code is valid — delete it
  await sql`DELETE FROM auth_codes WHERE email = ${email}`;

  // Find or create user
  let user = await sql`SELECT * FROM users WHERE email = ${email} LIMIT 1`;
  if (user.length === 0) {
    user = await sql`INSERT INTO users (email, display_name) VALUES (${email}, ${email.split("@")[0]}) RETURNING *`;
  }
  user = user[0];
  
  const token = sign({ userId: user.id, email: user.email });
  return jsonResponse({ ok: true, token, user });
}

module.exports = async (req) => handler(req);
