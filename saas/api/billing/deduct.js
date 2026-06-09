/**
 * TaskBolt Billing — Deduct credits after agent response
 * Called by desktop app after each successful agent run
 * Auth: user JWT (per-user deduction)
 */

const { requireAuth, jsonResponse } = require("../../lib/_auth");
const { sql, initDB } = require("../../lib/_db");

const TOKENS_PER_CREDIT = 200;

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  const { prompt_tokens, completion_tokens, model } = req.body || {};
  const totalTokens = (prompt_tokens || 0) + (completion_tokens || 0);

  if (!totalTokens) {
    return jsonResponse(res, { ok: true, deducted: 0, message: "No tokens to deduct" });
  }

  const creditsUsed = Math.ceil(totalTokens / TOKENS_PER_CREDIT);

  try {
    // Get current balance
    const credRows = await sql`SELECT balance FROM credits WHERE user_id = ${user.id}::uuid`;
    const currentBalance = credRows[0]?.balance || 0;

    // Deduct credits (never go below 0)
    const actualDeduct = Math.min(creditsUsed, currentBalance);
    if (actualDeduct > 0) {
      await sql`
        UPDATE credits SET
          balance = GREATEST(balance - ${actualDeduct}, 0),
          total_used = total_used + ${actualDeduct},
          updated_at = NOW()
        WHERE user_id = ${user.id}::uuid
      `;

      // Log usage
      await sql`
        INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, credits_deducted, endpoint)
        VALUES (${user.id}::uuid, ${model || 'unknown'}, ${prompt_tokens || 0}, ${completion_tokens || 0}, ${totalTokens}, ${actualDeduct}, 'desktop-agent')
      `;
    }

    const newBalance = Math.max(currentBalance - actualDeduct, 0);

    return jsonResponse(res, {
      ok: true,
      deducted: actualDeduct,
      tokens: totalTokens,
      balance: newBalance,
      rateLimited: newBalance <= 0,
    });
  } catch (e) {
    console.error("[deduct] Error:", e.message);
    return jsonResponse(res, { error: "Failed to deduct credits" }, 500);
  }
};
