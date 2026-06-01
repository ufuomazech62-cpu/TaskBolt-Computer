const { sql, initDB } = require("../_db");
const { sign } = require("../_jwt");
const { jsonResponse, setCorsHeaders } = require("../_auth");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "https://taskbolt.space/api/auth/google";

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { setCorsHeaders(res); return res.status(200).end(); }
  await initDB();

  // ── Poll action: frontend checks if OAuth completed ──
  if (req.method === "GET" && req.query.action === "poll") {
    const session = req.query.session;
    if (!session) return jsonResponse(res, { ok: false, error: "Missing session" }, 400);

    // Clean up expired sessions
    await sql`DELETE FROM oauth_sessions WHERE expires_at < NOW()`;

    const row = await sql`SELECT token, "user" FROM oauth_sessions WHERE session = ${session} LIMIT 1`;
    if (row.length === 0 || !row[0].token) {
      return jsonResponse(res, { ok: false });
    }

    // Delete session after successful poll (one-time use)
    await sql`DELETE FROM oauth_sessions WHERE session = ${session}`;
    return jsonResponse(res, { ok: true, token: row[0].token, user: row[0].user });
  }

  // ── Initiate OAuth: redirect to Google with state = session ID ──
  if (req.method === "GET" && !req.query.code) {
    const session = req.query.session || "";
    const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code",
      scope: "openid email profile", state: session, access_type: "offline", prompt: "consent",
    });
    setCorsHeaders(res);
    return res.redirect(url);
  }

  // ── OAuth callback: exchange code, store token in oauth_sessions ──
  if (req.method === "GET" && req.query.code) {
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: req.query.code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.id_token) return jsonResponse(res, { error: "Google auth failed" }, 400);

      const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
      const { email, sub: googleId, name, picture } = payload;

      let user = await sql`SELECT * FROM users WHERE google_id = ${googleId} LIMIT 1`;
      if (user.length === 0) {
        user = await sql`INSERT INTO users (email, google_id, display_name, avatar_url) VALUES (${email}, ${googleId}, ${name || null}, ${picture || null}) RETURNING *`;
      }
      user = user[0];
      const token = sign({ userId: user.id, email: user.email });

      // Store token in oauth_sessions for polling
      const session = req.query.state || "";
      if (session) {
        await sql`INSERT INTO oauth_sessions (session, token, "user", expires_at) VALUES (${session}, ${token}, ${JSON.stringify(user)}::jsonb, NOW() + INTERVAL '10 minutes') ON CONFLICT (session) DO UPDATE SET token = ${token}, "user" = ${JSON.stringify(user)}::jsonb, expires_at = NOW() + INTERVAL '10 minutes'`;
      }

      const html = `<!DOCTYPE html><html><head><title>Signed In</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f1117;color:#e4e4e7}div{text-align:center}h2{font-size:1.5rem;margin-bottom:0.5rem}p{color:#71717a}</style></head><body><div><h2>✅ Signed in to TaskBolt!</h2><p>You can close this window and return to the app.</p></div><script>setTimeout(()=>window.close(),2000)</script></body></html>`;
      setCorsHeaders(res); res.setHeader("Content-Type", "text/html");
      return res.status(200).send(html);
    } catch(e) { return jsonResponse(res, { error: e.message }, 500); }
  }

  return jsonResponse(res, { error: "Method not allowed" }, 405);
};
