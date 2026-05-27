const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.NEON_DATABASE_URL);

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
  const { email } = req.body;
  const cleanEmail = (email || "").toLowerCase().trim();
  if (!cleanEmail || !cleanEmail.includes("@")) return res.status(400).json({ error: "Valid email required" });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await sql`DELETE FROM auth_codes WHERE email = ${cleanEmail}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await sql`INSERT INTO auth_codes (email, code, expires_at) VALUES (${cleanEmail}, ${code}, ${expiresAt.toISOString()})`;

  let emailSent = false;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  
  if (RESEND_KEY) {
    try {
      const mailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "TaskBolt <onboarding@resend.dev>",
          to: [cleanEmail],
          subject: "Your TaskBolt sign-in code",
          html: `<div style="font-family:system-ui;max-width:400px;margin:0 auto;padding:2rem;"><h2 style="margin-bottom:0.5rem;">TaskBolt Sign-In Code</h2><p style="color:#666;margin-bottom:1.5rem;">Use this code to sign in:</p><div style="background:#f5f5f7;padding:1rem 2rem;border-radius:12px;text-align:center;font-size:2rem;font-weight:700;letter-spacing:0.3em;font-family:monospace;">${code}</div><p style="color:#999;font-size:0.8rem;margin-top:1.5rem;">Expires in 10 minutes.</p></div>`,
        }),
      });
      const data = await mailRes.json();
      emailSent = !!data.id;
    } catch(e) { console.error("Resend error:", e.message); }
  }

  if (!emailSent) {
    return res.status(200).json({ ok: true, sent: false, code, message: "Email service not configured. Code shown for testing." });
  }
  return res.status(200).json({ ok: true, sent: true, message: "Code sent to your email" });
};
