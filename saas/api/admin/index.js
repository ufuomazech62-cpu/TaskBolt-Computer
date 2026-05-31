const { sql, initDB } = require("../_db");

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

    return res.status(400).json({ error: "Unknown action. Use: status, credit, fix_pending" });
  } catch (err) {
    console.error("[admin] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
