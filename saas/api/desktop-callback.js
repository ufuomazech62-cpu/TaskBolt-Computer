/**
 * Desktop Auth Callback — /api/desktop-callback
 * After web sign-in, generates an API key and redirects to taskbolt://auth?key=xxx
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

  const user = requireAuth(req);
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

  // Redirect to desktop app with the key
  const redirectUrl = `taskbolt://auth?key=${encodeURIComponent(rawKey)}`;
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Signing in to TaskBolt...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      background: #0f1117;
      color: #e4e4e7;
    }
    div { text-align: center; }
    h2 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #71717a; }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: #22c55e;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div>
    <div class="spinner"></div>
    <h2>✅ Signed in to TaskBolt!</h2>
    <p>Opening desktop app...</p>
  </div>
  <script>
    // Redirect to desktop app
    window.location.href = "${redirectUrl}";
    // Fallback: close after 3s if redirect doesn't work
    setTimeout(() => {
      document.querySelector('p').textContent = 'You can close this window.';
      window.close();
    }, 3000);
  </script>
</body>
</html>`;

  setCorsHeaders(res);
  res.setHeader("Content-Type", "text/html");
  return res.status(200).send(html);
};
