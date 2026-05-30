const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.NEON_DATABASE_URL);

async function initDB() {
  await sql`CREATE TABLE IF NOT EXISTS users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email TEXT, google_id TEXT UNIQUE, github_id TEXT UNIQUE, telegram_id BIGINT UNIQUE,
    username TEXT, display_name TEXT, avatar_url TEXT,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS auth_codes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email TEXT NOT NULL, code TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS tasks (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, messages JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS skills (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT, config JSONB DEFAULT '{}',
    enabled BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS mcp_servers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, url TEXT NOT NULL, transport TEXT DEFAULT 'sse',
    enabled BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS telegram_logins (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    token TEXT NOT NULL UNIQUE, telegram_id BIGINT, username TEXT, first_name TEXT,
    expires_at TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT NOW()
  )`;

  // Credits (simplified — no daily bonus)
  await sql`CREATE TABLE IF NOT EXISTS credits (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    balance INTEGER NOT NULL DEFAULT 0,
    total_allocated INTEGER NOT NULL DEFAULT 0,
    total_used INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS usage_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    model TEXT, prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0, credits_deducted INTEGER DEFAULT 0,
    endpoint TEXT, created_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS transactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, credits INTEGER DEFAULT 0, amount_ngn INTEGER,
    flutterwave_ref TEXT, status TEXT DEFAULT 'pending',
    metadata JSONB DEFAULT '{}', created_at TIMESTAMP DEFAULT NOW()
  )`;

  // Memory table for AI context
  await sql`CREATE TABLE IF NOT EXISTS memories (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL, importance INTEGER DEFAULT 5,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`;

  // Cron jobs table
  await sql`CREATE TABLE IF NOT EXISTS cron_jobs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, schedule TEXT NOT NULL,
    task TEXT NOT NULL, enabled BOOLEAN DEFAULT true,
    last_run TIMESTAMP, next_run TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_credits_user ON credits(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cron_user ON cron_jobs(user_id, enabled)`;
}

module.exports = { sql, initDB };
