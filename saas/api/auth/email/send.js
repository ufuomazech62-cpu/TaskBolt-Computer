const { sql, initDB } = require("../../_db");
const { jsonResponse } = require("../../_auth");

async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: require("../../_auth").corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  
  await initDB();
  const body = await req.json();
  const email = body.email?.toLowerCase().trim();
  if (!email || !email.includes("@")) return jsonResponse({ error: "Valid email required" }, 400);

  // Generate 6-digit code
  const code = String(Math.floor(100000 + Math.random() * 900000));
  
  // Remove old codes for this email
  await sql`DELETE FROM auth_codes WHERE email = ${email}`;
  
  // Store new code (expires in 10 minutes)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await sql`INSERT INTO auth_codes (email, code, expires_at) VALUES (${email}, ${code}, ${expiresAt.toISOString()})`;

  // Send email via Resend
  let emailSent = false;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  
  if (RESEND_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "TaskBolt <auth@taskbolt.app>",
          to: [email],
          subject: "Your TaskBolt sign-in code",
          html: `<div style="font-family:system-ui;max-width:400px;margin:0 auto;padding:2rem;">
            <h2 style="margin-bottom:0.5rem;">TaskBolt Sign-In Code</h2>
            <p style="color:#666;margin-bottom:1.5rem;">Use this code to sign in:</p>
            <div style="background:#f5f5f7;padding:1rem 2rem;border-radius:12px;text-align:center;font-size:2rem;font-weight:700;letter-spacing:0.3em;font-family:monospace;">${code}</div>
            <p style="color:#999;font-size:0.8rem;margin-top:1.5rem;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
          </div>`,
        }),
      });
      const data = await res.json();
      emailSent = !!data.id;
    } catch(e) {
      console.error("Resend error:", e.message);
    }
  }

  // If Resend not configured, return code in response (dev mode)
  if (!emailSent) {
    return jsonResponse({ ok: true, sent: false, code, message: "Email service not configured. Code returned for testing." });
  }

  return jsonResponse({ ok: true, sent: true, message: "Code sent to your email" });
}

module.exports = async (req) => handler(req);
