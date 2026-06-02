/**
 * TaskBolt Agent API — Tool-calling + Auth + Credits
 * API key stays on server — users can never access it
 * 1 credit = 200 tokens
 */

const { requireAuth, jsonResponse } = require("../../lib/_auth");
const { sql, initDB } = require("../../lib/_db");

const API_BASE = process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const TOKENS_PER_CREDIT = 200;

// Valid models — if client sends invalid, fallback to qwen-plus (confirmed working with tools)
const VALID_MODELS = ["deepseek-v4-flash", "qwen-plus", "qwen-max", "qwen-turbo"];

/**
 * Sanitize upstream API errors — never expose provider names, billing info,
 * model details, or internal error codes to end users.
 */
function sanitizeUpstreamError(status, rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const code = parsed.error?.code || parsed.code || "";
    // Rate limit / quota
    if (status === 429 || code === "RateLimitReached" || code === "Throttling") {
      return "We're experiencing high demand right now. Please try again in a moment.";
    }
    // Billing / arrearage
    if (code === "Arrearage" || code === "InsufficientBalance" || rawBody.includes("overdue")) {
      return "Our service is temporarily unavailable. We're working on it — please try again shortly.";
    }
    // Auth / key issues
    if (status === 401 || status === 403 || code === "InvalidApiKey") {
      return "Service configuration error. Our team has been notified.";
    }
    // Model not found
    if (code === "ModelNotFound" || code === "InvalidModel") {
      return "Service temporarily unavailable. Please try again.";
    }
  } catch {
    // Not JSON — still sanitize
  }
  if (status === 429) return "Too many requests. Please wait a moment and try again.";
  if (status >= 500) return "Our AI service is temporarily unavailable. Please try again in a few moments.";
  return "Something went wrong processing your request. Please try again.";
}

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
      rateLimited: true,
      message: "You've used all your credits. Upgrade your plan or buy a top-up to continue.",
    }, 402);
  }

  const { messages, tools, model } = req.body;
  if (!messages || !messages.length) return jsonResponse(res, { error: "messages required" }, 400);

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return jsonResponse(res, { error: "Service temporarily unavailable. Please try again." }, 500);

  const useModel = VALID_MODELS.includes(model) ? model : "qwen-plus";

  // Build request body with tools
  const body = {
    model: useModel,
    messages,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  try {
    // Try primary model
    let response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    // If primary model fails with model error, retry with fallback
    if (!response.ok && (response.status === 400 || response.status === 404)) {
      const errBody = await response.text();
      try {
        const parsed = JSON.parse(errBody);
        const code = parsed.error?.code || "";
        if (code === "ModelNotFound" || code === "InvalidModel" || errBody.includes("model")) {
          console.log(`[agent] Model ${useModel} failed, retrying with qwen-plus`);
          body.model = "qwen-plus";
          response = await fetch(`${API_BASE}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
        }
      } catch {}
    }

    if (!response.ok) {
      const errBody = await response.text();
      console.error("[agent] Upstream API error:", response.status, errBody.slice(0, 300));
      const userMessage = sanitizeUpstreamError(response.status, errBody);
      return res.status(502).json({ error: userMessage });
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
    console.error("[agent] Unexpected error:", e.message);
    return res.status(500).json({ error: "An unexpected error occurred. Please try again." });
  }
};
