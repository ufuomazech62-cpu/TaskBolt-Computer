const { sql, initDB } = require("../../lib/_db");

// Admin endpoint to diagnose and fix credit issues
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  const adminSecret = process.env.ADMIN_SECRET || "taskbolt-admin-2026";
  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${adminSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  await initDB();
  const action = req.query.action || "status";

  try {
    // --- STATUS: show all users, credits, transactions ---
    if (action === "status") {
      const users = await sql`SELECT id, email, username, created_at FROM users ORDER BY created_at DESC LIMIT 20`;
      const credits = await sql`SELECT user_id, balance, total_allocated, total_used, updated_at FROM credits ORDER BY updated_at DESC`;
      const transactions = await sql`SELECT id, user_id, type, credits, status, metadata, created_at FROM transactions ORDER BY created_at DESC LIMIT 20`;
      return res.status(200).json({ ok: true, users, credits, transactions });
    }

    // --- CREDIT: manually add credits to a user ---
    if (action === "credit" && req.method === "POST") {
      const { user_id, credits, reason } = req.body || {};
      if (!user_id || !credits) return res.status(400).json({ error: "user_id and credits required" });

      const existing = await sql`SELECT id FROM credits WHERE user_id = ${user_id}::uuid`;
      if (existing.length === 0) {
        await sql`INSERT INTO credits (user_id, balance, total_allocated, total_used) VALUES (${user_id}::uuid, ${credits}, ${credits}, 0)`;
      } else {
        await sql`UPDATE credits SET balance = balance + ${credits}, total_allocated = total_allocated + ${credits}, updated_at = NOW() WHERE user_id = ${user_id}::uuid`;
      }

      await sql`INSERT INTO transactions (user_id, type, credits, status, metadata) VALUES (${user_id}::uuid, 'admin_credit', ${credits}, 'completed', ${JSON.stringify({ reason: reason || "manual_admin_credit" })}::jsonb)`;

      const updated = await sql`SELECT balance, total_allocated, total_used FROM credits WHERE user_id = ${user_id}::uuid`;
      return res.status(200).json({ ok: true, message: `Added ${credits} credits`, balance: updated[0] });
    }

    // --- FIX_PENDING: find pending transactions from successful payments and complete them ---
    if (action === "fix_pending" && req.method === "POST") {
      const pending = await sql`SELECT id, user_id, credits, metadata FROM transactions WHERE status = 'pending' AND type = 'purchase' ORDER BY created_at DESC`;
      const results = [];
      for (const tx of pending) {
        const credits = tx.credits || 0;
        if (credits <= 0) continue;

        const existing = await sql`SELECT id FROM credits WHERE user_id = ${tx.user_id}::uuid`;
        if (existing.length === 0) {
          await sql`INSERT INTO credits (user_id, balance, total_allocated, total_used) VALUES (${tx.user_id}::uuid, ${credits}, ${credits}, 0)`;
        } else {
          await sql`UPDATE credits SET balance = balance + ${credits}, total_allocated = total_allocated + ${credits}, updated_at = NOW() WHERE user_id = ${tx.user_id}::uuid`;
        }
        await sql`UPDATE transactions SET status = 'completed', flutterwave_ref = 'admin-fix-${Date.now()}' WHERE id = ${tx.id}::uuid`;
        results.push({ tx_id: tx.id, user_id: tx.user_id, credits, status: "completed" });
      }
      return res.status(200).json({ ok: true, fixed: results.length, results });
    }

    // --- PROCESS_TX: properly process a specific pending transaction (same logic as webhook) ---
    if (action === "process_tx" && req.method === "POST") {
      const { transaction_id, user_id } = req.body || {};
      if (!transaction_id || !user_id) return res.status(400).json({ error: "transaction_id and user_id required" });

      // Verify the transaction exists and is pending
      const txRows = await sql`SELECT id, user_id, credits, status, metadata FROM transactions WHERE id = ${transaction_id}::uuid`;
      if (txRows.length === 0) return res.status(404).json({ error: "Transaction not found" });
      const tx = txRows[0];
      if (tx.status === 'completed') return res.status(400).json({ error: "Transaction already completed" });

      const credits = tx.credits || 0;

      // Verify user exists
      const userRows = await sql`SELECT id, email FROM users WHERE id = ${user_id}::uuid`;
      if (userRows.length === 0) return res.status(404).json({ error: "User not found" });

      // Link user_id to transaction (was null due to the bug)
      await sql`UPDATE transactions SET user_id = ${user_id}::uuid WHERE id = ${transaction_id}::uuid`;

      // Add credits (same logic as webhook)
      const existing = await sql`SELECT id FROM credits WHERE user_id = ${user_id}::uuid`;
      if (existing.length === 0) {
        await sql`INSERT INTO credits (user_id, balance, total_allocated, total_used) VALUES (${user_id}::uuid, ${credits}, ${credits}, 0)`;
      } else {
        await sql`UPDATE credits SET balance = balance + ${credits}, total_allocated = total_allocated + ${credits}, updated_at = NOW() WHERE user_id = ${user_id}::uuid`;
      }

      // Mark transaction complete
      await sql`UPDATE transactions SET status = 'completed' WHERE id = ${transaction_id}::uuid`;

      const updated = await sql`SELECT balance, total_allocated, total_used FROM credits WHERE user_id = ${user_id}::uuid`;
      return res.status(200).json({
        ok: true,
        message: `Processed: ${credits} credits added`,
        user: userRows[0].email,
        balance: updated[0],
        transaction: { id: transaction_id, credits, status: 'completed' }
      });
    }

    // --- DEBUG: test connectivity ---
    if (action === "debug") {
      const results = { env: {} };
      results.env.DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY ? `set (${process.env.DASHSCOPE_API_KEY.slice(0,15)}...)` : "NOT SET";
      results.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL ? "set" : "NOT SET";
      results.env.COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY ? "set" : "NOT SET";
      const API_BASE = process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
      if (process.env.DASHSCOPE_API_KEY) {
        try {
          const r = await fetch(API_BASE + "/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + process.env.DASHSCOPE_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ model: "qwen-plus", messages: [{role:"user",content:"ok"}], max_tokens: 5 }) });
          results.dashscope = { status: r.status, ok: r.ok };
        } catch(e) { results.dashscope = { error: e.message }; }
      }
      try { const u = await sql`SELECT COUNT(*) as c FROM users`; results.db = { ok: true, users: u[0]?.c }; } catch(e) { results.db = { ok: false, error: e.message }; }
      return res.json(results);
    }

    return res.status(400).json({ error: "Unknown action. Use: status, credit, fix_pending, debug" });
  } catch (err) {
    console.error("[admin] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
