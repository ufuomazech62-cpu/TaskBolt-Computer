const { sql, initDB } = require("../_db");
const { sign } = require("../_jwt");
const { jsonResponse, corsHeaders } = require("../_auth");
const crypto = require("crypto");

const CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const REDIRECT_URI = "https://taskbolt-saas.vercel.app/api/auth/callback/github";

async function handler(req) {
  await initDB();
  
  if (req.method === "GET" && !req.url.includes("code=")) {
    const url = "https://github.com/login/oauth/authorize?" + new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "user:email",
    });
    return new Response("", { status: 302, headers: { Location: url, ...corsHeaders() } });
  }

  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    if (!code) return jsonResponse({ error: "No code" }, 400);

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return jsonResponse({ error: "GitHub auth failed" }, 400);

    // Get user info
    const [userRes, emailsRes] = await Promise.all([
      fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/vnd.github.v3+json" } }),
      fetch("https://api.github.com/user/emails", { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/vnd.github.v3+json" } }),
    ]);
    const ghUser = await userRes.json();
    const emails = await emailsRes.json();
    const primaryEmail = emails.find(e => e.primary)?.email || ghUser.email;

    let user = await sql`SELECT * FROM users WHERE github_id = ${String(ghUser.id)} LIMIT 1`;
    if (user.length === 0) {
      user = await sql`INSERT INTO users (email, github_id, username, display_name, avatar_url) VALUES (${primaryEmail}, ${String(ghUser.id)}, ${ghUser.login}, ${ghUser.name || ghUser.login}, ${ghUser.avatar_url || null}) RETURNING *`;
    }
    user = user[0];
    const token = sign({ userId: user.id, email: user.email });
    
    const html = `<html><body><script>
      const token = "${token}";
      const user = ${JSON.stringify(user)};
      try { window.opener.postMessage({ type: "auth", token, user }, "*"); } catch(e) {}
      document.body.innerHTML = '<h2 style="font-family:system-ui;text-align:center;margin-top:30vh;">✅ Signed in to TaskBolt!</h2><p style="text-align:center;color:#666;">You can close this window.</p>';
    </script></body></html>`;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  }
  
  return jsonResponse({ error: "Method not allowed" }, 405);
}

module.exports = async (req) => handler(req);
