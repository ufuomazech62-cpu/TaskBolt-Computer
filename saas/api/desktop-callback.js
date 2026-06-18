/**
 * Desktop Auth Callback — /api/desktop-callback
 * After web sign-in, generates an API key and shows success page with buttons
 */

const crypto = require("crypto");
const { requireAuth, jsonResponse, setCorsHeaders } = require("../lib/_auth");
const { sql, initDB } = require("../lib/_db");

function generateApiKey() {
  const randomPart = crypto.randomBytes(24).toString("base64url").slice(0, 32);
  const rawKey = `tb_${randomPart}`;
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.substring(0, 10);
  return { rawKey, keyHash, keyPrefix };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  await initDB();

  // Ensure api_keys table exists
  await sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      name TEXT DEFAULT 'Default',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      last_used_at TIMESTAMP
    )
  `;

  // Get user from auth header OR token query param
  let user = requireAuth(req);
  if (!user) {
    const tokenParam = req.query?.token || new URL(req.url, `https://${req.headers.host}`).searchParams.get('token');
    if (tokenParam) {
      const { verify } = require("../lib/_jwt");
      const payload = verify(tokenParam);
      if (payload) {
        user = { ...payload, id: payload.userId || payload.id };
      }
    }
  }
  if (!user) {
    setCorsHeaders(res);
    return res.status(401).json({ error: "Unauthorized — sign in first" });
  }

  // Deactivate old keys for this user
  await sql`UPDATE api_keys SET is_active = false WHERE user_id = ${user.id}::uuid`;

  // Generate new API key
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  
  await sql`
    INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
    VALUES (${user.id}::uuid, ${keyHash}, ${keyPrefix}, 'Desktop App (auto)')
  `;

  // Show success page with buttons
  const redirectUrl = `taskbolt://auth?key=${encodeURIComponent(rawKey)}`;
  const userEmail = user.email || '';
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signed In — TaskBolt</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', sans-serif;
      background: hsl(201, 100%, 13%);
      color: white;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container { max-width: 400px; width: 90%; text-align: center; }
    .logo {
      width: 56px; height: 56px; margin: 0 auto 1.5rem;
      border-radius: 16px;
      background: linear-gradient(135deg, #FF9A1F, #FF2F92, #C026FF);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.8rem;
    }
    h1 { font-family: 'Instrument Serif', serif; font-size: 2.2rem; margin-bottom: 0.5rem; }
    .subtitle { color: rgba(255,255,255,0.5); margin-bottom: 2rem; font-size: 0.95rem; }
    .success-icon {
      width: 64px; height: 64px; margin: 0 auto 1.5rem;
      border-radius: 50%;
      background: rgba(34,197,94,0.15);
      display: flex; align-items: center; justify-content: center;
    }
    .success-icon svg { width: 32px; height: 32px; color: #22c55e; }
    .btn {
      display: flex; align-items: center; justify-content: center; gap: 12px;
      width: 100%; padding: 14px 20px; border: none; border-radius: 12px;
      font-size: 0.95rem; font-weight: 600; cursor: pointer;
      transition: all 0.2s; margin-bottom: 12px; text-decoration: none;
    }
    .btn-app {
      background: linear-gradient(135deg, #FF9A1F, #FF2F92); color: white;
    }
    .btn-app:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn-dashboard {
      background: rgba(255,255,255,0.1); color: white; border: 1px solid rgba(255,255,255,0.15);
    }
    .btn-dashboard:hover { background: rgba(255,255,255,0.15); transform: translateY(-1px); }
    .btn svg { width: 20px; height: 20px; }
    .close-note { color: rgba(255,255,255,0.35); font-size: 0.8rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo"><img src="https://taskbolt.space/icon.png" alt="TaskBolt" style="width:48px;height:48px;border-radius:12px"></div>
    <h1>You're In!</h1>
    <p class="subtitle">Where would you like to go?</p>

    <div class="success-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
      </svg>
    </div>

    <a class="btn btn-app" href="${redirectUrl}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
      </svg>
      Open Desktop App
    </a>

    <a class="btn btn-dashboard" href="/dashboard.html">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/>
      </svg>
      Visit Dashboard
    </a>

    <p class="close-note">You can close this tab after opening the app.</p>
  </div>
</body>
</html>`;

  setCorsHeaders(res);
  res.setHeader("Content-Type", "text/html");
  return res.status(200).send(html);
};
