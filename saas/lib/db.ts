import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

const DB_PATH = process.env.DATABASE_PATH || join(process.cwd(), 'taskbolt.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    
    // Enable WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    
    // Initialize schema
    const schema = readFileSync(join(process.cwd(), 'schema.sql'), 'utf-8');
    db.exec(schema);
    
    console.log('[DB] Database initialized at', DB_PATH);
  }
  
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Helper functions for common operations

export interface User {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  provider: string;
  provider_id: string;
  credits: number;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  credits_allocated: number;
  credits_used: number;
  is_active: number;
  created_at: string;
  last_used_at: string | null;
}

export interface UsageLog {
  id: string;
  user_id: string;
  api_key_id: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  credits_deducted: number;
  endpoint: string;
  created_at: string;
}

export function getUserById(id: string): User | undefined {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(id) as User | undefined;
}

export function getUserByEmail(email: string): User | undefined {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
  return stmt.get(email) as User | undefined;
}

export function createUser(user: Omit<User, 'created_at' | 'updated_at'>): User {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO users (id, email, name, image, provider, provider_id, credits)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    user.id,
    user.email,
    user.name,
    user.image,
    user.provider,
    user.provider_id,
    user.credits
  );
  
  return getUserById(user.id)!;
}

export function updateUserCredits(userId: string, amount: number): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE users 
    SET credits = credits + ?, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `);
  stmt.run(amount, userId);
}

export function getApiKeysByUserId(userId: string): ApiKey[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC');
  return stmt.all(userId) as ApiKey[];
}

export function getApiKeyByHash(keyHash: string): ApiKey | undefined {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1');
  return stmt.get(keyHash) as ApiKey | undefined;
}

export function createApiKey(apiKey: Omit<ApiKey, 'created_at' | 'last_used_at'>): ApiKey {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, credits_allocated, credits_used, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    apiKey.id,
    apiKey.user_id,
    apiKey.key_hash,
    apiKey.key_prefix,
    apiKey.name,
    apiKey.credits_allocated,
    apiKey.credits_used,
    apiKey.is_active
  );
  
  return { ...apiKey, created_at: new Date().toISOString(), last_used_at: null };
}

export function updateApiKeyUsage(apiKeyId: string, creditsUsed: number): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE api_keys 
    SET credits_used = credits_used + ?, last_used_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `);
  stmt.run(creditsUsed, apiKeyId);
}

export function logUsage(log: Omit<UsageLog, 'created_at'>): UsageLog {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO usage_logs (id, user_id, api_key_id, model, prompt_tokens, completion_tokens, total_tokens, credits_deducted, endpoint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    log.id,
    log.user_id,
    log.api_key_id,
    log.model,
    log.prompt_tokens,
    log.completion_tokens,
    log.total_tokens,
    log.credits_deducted,
    log.endpoint
  );
  
  return { ...log, created_at: new Date().toISOString() };
}

export function logCreditTransaction(
  userId: string,
  amount: number,
  type: 'purchase' | 'usage' | 'refund' | 'bonus',
  description: string,
  referenceId?: string
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO credit_transactions (id, user_id, amount, type, description, reference_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    crypto.randomUUID(),
    userId,
    amount,
    type,
    description,
    referenceId || null
  );
}

// Verification tokens for passwordless email
export function createVerificationToken(identifier: string, token: string, expires: Date): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO verification_tokens (identifier, token, expires)
    VALUES (?, ?, ?)
  `);
  stmt.run(identifier, token, expires.toISOString());
}

export function getVerificationToken(identifier: string, token: string): { identifier: string; token: string; expires: string } | undefined {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM verification_tokens WHERE identifier = ? AND token = ?');
  return stmt.get(identifier, token) as { identifier: string; token: string; expires: string } | undefined;
}

export function deleteVerificationToken(identifier: string, token: string): void {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM verification_tokens WHERE identifier = ? AND token = ?');
  stmt.run(identifier, token);
}

export function getUserUsageStats(userId: string, days: number = 7) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT 
      COUNT(*) as total_requests,
      SUM(total_tokens) as total_tokens,
      SUM(credits_deducted) as total_credits_used,
      MIN(created_at) as earliest_usage,
      MAX(created_at) as latest_usage
    FROM usage_logs 
    WHERE user_id = ? 
      AND created_at > datetime('now', '-' || ? || ' days')
  `);
  
  return stmt.get(userId, days) as {
    total_requests: number;
    total_tokens: number;
    total_credits_used: number;
    earliest_usage: string | null;
    latest_usage: string | null;
  };
}
