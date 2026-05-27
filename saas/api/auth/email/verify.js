const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = neon(process.env.NEON_DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || "taskbolt-jwt-s3cr3t-2026";

function b64url(buf) { return buf.toString("base64url"); }
function sign(payload) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const pl = b64url(Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 86400*365 })));
  const sig = b64url(crypto.createHmac("sha256", JWT_SECRET).update(header + "." + pl).digest());
  return header + "." + pl + "." + sig;
}

async function initDB() {
  await sql`CREATE TABLE IF NOT EXISTS users (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, email TEXT, google_id TEXT, github_id TEXT, telegram_id BIGINT, username TEXT, display_name TEXT, avatar_url TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS auth_codes (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, email TEXT NOT NULL, code TEXT NOT NULL, expires_at TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT NOW())`;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  
  await initDB();
  const { email, code } = req.body;
  const cleanEmail = (email || "").toLowerCase().trim();
  const cleanCode = (code || "").trim();
  
  if (!cleanEmail || !cleanCode) return res.status(400).json({ error: "Email and code required" });

  const codes = await sql`SELECT * FROM auth_codes WHERE email = ${cleanEmail} AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`;
  
  if (codes.length === 0 || codes[0].code !== cleanCode) {
    return res.status(400).json({ ok: false, error: "Invalid or expired code. Try again." });
  }

  await sql`DELETE FROM auth_codes WHERE email = ${cleanEmail}`;

  let user = await sql`SELECT * FROM users WHERE email = ${cleanEmail} LIMIT 1`;
  if (user.length === 0) {
    user = await sql`INSERT INTO users (email, display_name) VALUES (${cleanEmail}, ${cleanEmail.split("@")[0]}) RETURNING *`;
  }
  user = user[0];
  
  const token = sign({ userId: user.id, email: user.email });
  return res.status(200).json({ ok: true, token, user });
};
