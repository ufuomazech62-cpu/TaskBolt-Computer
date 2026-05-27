const { sql, initDB } = require("../../_db");
const { jsonResponse, setCorsHeaders } = require("../../_auth");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { setCorsHeaders(res); return res.status(200).end(); }
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);
  
  await initDB();
  const { email } = req.body;
  const cleanEmail = (email || "").toLowerCase().trim();
  if (!cleanEmail || !cleanEmail.includes("@")) return jsonResponse(res, { error: "Valid email required" }, 400);

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
    return jsonResponse(res, { ok: true, sent: false, code, message: "Email service not configured. Code shown for testing." });
  }
  return jsonResponse(res, { ok: true, sent: true, message: "Code sent to your email" });
};
