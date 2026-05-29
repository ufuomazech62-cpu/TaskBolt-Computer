/**
 * TaskBolt Agent API — Tool-calling + Auth + Credits
 * API key stays on server — users can never access it
 * 1 credit = 200 tokens
 */

const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");

const API_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const TOKENS_PER_CREDIT = 200;

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return jsonResponse(res, { error: "POST only" }, 405);

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  await initDB();

  // Check credits balance
  const credRows = await sql`SELECT balance FROM credits WHERE user_id = ${user.id}::uuid`;
  const balance = credRows[0]?.balance || 0;
  if (balance <= 0) {
    return jsonResponse(res, {
      error: "No credits remaining",
      credits: 0,
      message: "Please subscribe to a plan or claim your daily bonus.",
    }, 402);
  }

  const { messages, tools, model } = req.body;
  if (!messages || !messages.length) return jsonResponse(res, { error: "messages required" }, 400);

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return jsonResponse(res, { error: "DASHSCOPE_API_KEY not configured" }, 500);

  const useModel = model || "qwen3.6-flash";

  // Build request body with tools
  const body = {
    model: useModel,
    messages,
    extra_body: { enable_thinking: true },
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err.slice(0, 500) });
    }

    const data = await response.json();

    // Log usage and deduct credits
    const usage = data.usage || {};
    const pTokens = usage.prompt_tokens || 0;
    const cTokens = usage.completion_tokens || 0;
    const totalTokens = pTokens + cTokens;
    const creditsUsed = Math.ceil(totalTokens / TOKENS_PER_CREDIT);

    if (creditsUsed > 0) {
      await sql`
        UPDATE credits SET
          balance = GREATEST(balance - ${creditsUsed}, 0),
          total_used = total_used + ${creditsUsed},
          updated_at = NOW()
        WHERE user_id = ${user.id}::uuid
      `;

      await sql`
        INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, credits_deducted, endpoint)
        VALUES (${user.id}::uuid, ${useModel}, ${pTokens}, ${cTokens}, ${totalTokens}, ${creditsUsed}, 'agent')
      `;
    }

    data._credits = { used: creditsUsed, remaining: Math.max(balance - creditsUsed, 0) };

    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
