const { sql, initDB } = require("../_db");
const { sign } = require("../_jwt");
const { jsonResponse } = require("../_auth");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "https://taskbolt-saas.vercel.app/api/auth/callback/google";

async function handler(req) {
  await initDB();
  
  // Step 1: Redirect to Google
  if (req.method === "GET" && !req.url.includes("code=")) {
    const state = crypto.randomUUID();
    const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return new Response("", { status: 302, headers: { Location: url, ...corsHeaders() } });
  }

  // Step 2: Handle callback
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    if (!code) return jsonResponse({ error: "No code" }, 400);

    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.id_token) return jsonResponse({ error: "Google auth failed" }, 400);

    // Decode ID token (simple decode, no verification needed for desktop app)
    const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
    const { email, sub: googleId, name, picture } = payload;

    // Find or create user
    let user = await sql`SELECT * FROM users WHERE google_id = ${googleId} LIMIT 1`;
    if (user.length === 0) {
      user = await sql`INSERT INTO users (email, google_id, display_name, avatar_url) VALUES (${email}, ${googleId}, ${name || null}, ${picture || null}) RETURNING *`;
    }
    user = user[0];
    const token = sign({ userId: user.id, email: user.email });
    
    // Return HTML that posts the token back to the desktop app
    const html = `<html><body><script>
      const token = "${token}";
      const user = ${JSON.stringify(user)};
      // Try to communicate with desktop app
      try { window.opener.postMessage({ type: "auth", token, user }, "*"); } catch(e) {}
      document.body.innerHTML = '<h2 style="font-family:system-ui;text-align:center;margin-top:30vh;">✅ Signed in to TaskBolt!</h2><p style="text-align:center;color:#666;">You can close this window.</p>';
    </script></body></html>`;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  }
  
  return jsonResponse({ error: "Method not allowed" }, 405);
}

const { corsHeaders } = require("../_auth");
const crypto = require("crypto");
module.exports = async (req) => handler(req);
