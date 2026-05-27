const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.NEON_DATABASE_URL);

async function initDB() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      email TEXT,
      google_id TEXT,
      github_id TEXT,
      telegram_id BIGINT,
      username TEXT,
      display_name TEXT,
      avatar_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS auth_codes (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id UUID REFERENCES users(id),
      title TEXT NOT NULL,
      messages JSONB DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS skills (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id UUID REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT,
      config JSONB DEFAULT '{}',
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id UUID REFERENCES users(id),
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      transport TEXT DEFAULT 'sse',
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS telegram_logins (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      telegram_id BIGINT,
      username TEXT,
      first_name TEXT,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`;
}

module.exports = { sql, initDB };
