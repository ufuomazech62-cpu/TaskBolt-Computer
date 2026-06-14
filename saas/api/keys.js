/**
 * API Key Management — /api/keys
 * Create, list, revoke API keys for desktop app authentication
 */

const crypto = require("crypto");
const { requireAuth, jsonResponse } = require("../lib/_auth");
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
  await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`;

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  // CREATE key (POST)
  if (req.method === "POST") {
    const { name } = req.body || {};
    const keyName = name || "Desktop App";
    
    // Check if user already has an active key (max 3)
    const existing = await sql`SELECT COUNT(*) as count FROM api_keys WHERE user_id = ${user.id}::uuid AND is_active = true`;
    if (existing[0].count >= 3) {
      return jsonResponse(res, { error: "Maximum 3 active API keys. Revoke one first." }, 400);
    }

    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    
    await sql`
      INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
      VALUES (${user.id}::uuid, ${keyHash}, ${keyPrefix}, ${keyName})
    `;

    return jsonResponse(res, {
      ok: true,
      key: rawKey, // Shown ONCE — user must copy it
      prefix: keyPrefix,
      name: keyName,
      message: "⚠️ Copy this key now. It won't be shown again."
    });
  }

  // LIST keys (GET)
  if (req.method === "GET") {
    const keys = await sql`
      SELECT id, key_prefix, name, is_active, created_at, last_used_at
      FROM api_keys
      WHERE user_id = ${user.id}::uuid
      ORDER BY created_at DESC
    `;
    return jsonResponse(res, { ok: true, keys });
  }

  // REVOKE key (DELETE)
  if (req.method === "DELETE") {
    const { key_id } = req.body || {};
    if (!key_id) return jsonResponse(res, { error: "key_id required" }, 400);
    
    await sql`
      UPDATE api_keys SET is_active = false
      WHERE id = ${key_id}::uuid AND user_id = ${user.id}::uuid
    `;
    return jsonResponse(res, { ok: true, message: "Key revoked" });
  }

  return jsonResponse(res, { error: "Method not allowed" }, 405);
};
