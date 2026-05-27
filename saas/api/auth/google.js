const { sql, initDB } = require("../_db");
const { sign } = require("../_jwt");
const { jsonResponse, setCorsHeaders } = require("../_auth");
const crypto = require("crypto");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "https://taskbolt-saas.vercel.app/api/auth/callback/google";

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { setCorsHeaders(res); return res.status(200).end(); }
  await initDB();
  
  if (req.method === "GET" && !req.query.code) {
    const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code",
      scope: "openid email profile", state: crypto.randomUUID(), access_type: "offline", prompt: "consent",
    });
    setCorsHeaders(res);
    return res.redirect(url);
  }

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
      
      const html = `<html><body><script>const t="${token}",u=${JSON.stringify(user)};try{window.opener.postMessage({type:"auth",token:t,user:u},"*")}catch(e){}document.body.innerHTML='<h2 style=font-family:system-ui;text-align:center;margin-top:30vh>\\u2705 Signed in to TaskBolt!</h2><p style=text-align:center;color:#666>You can close this window.</p>'</script></body></html>`;
      setCorsHeaders(res); res.setHeader("Content-Type", "text/html");
      return res.status(200).send(html);
    } catch(e) { return jsonResponse(res, { error: e.message }, 500); }
  }
  
  return jsonResponse(res, { error: "Method not allowed" }, 405);
};
