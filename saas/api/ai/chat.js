/**
 * TaskBolt Chat API — Authenticated + Credit-based
 * 1 credit = 200 tokens
 */

const { requireAuth, jsonResponse } = require("../../lib/_auth");
const { sql, initDB } = require("../../lib/_db");

const API_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const TOKENS_PER_CREDIT = 200;

/**
 * Sanitize upstream API errors — never expose provider names, billing info,
 * model details, or internal error codes to end users.
 */
function sanitizeUpstreamError(status, rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const code = parsed.error?.code || parsed.code || "";
    if (status === 429 || code === "RateLimitReached" || code === "Throttling") {
      return "We're experiencing high demand right now. Please try again in a moment.";
    }
    if (code === "Arrearage" || code === "InsufficientBalance" || rawBody.includes("overdue")) {
      return "Our service is temporarily unavailable. We're working on it — please try again shortly.";
    }
    if (status === 401 || status === 403 || code === "InvalidApiKey") {
      return "Service configuration error. Our team has been notified.";
    }
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

  const { messages, model, stream } = req.body;
  if (!messages || !messages.length) return jsonResponse(res, { error: "messages required" }, 400);

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return jsonResponse(res, { error: "Service temporarily unavailable. Please try again." }, 500);

  const useModel = model || "deepseek-v4-flash";

  // Helper to log usage and deduct credits
  async function logUsage(promptTokens, completionTokens) {
    const totalTokens = promptTokens + completionTokens;
    const creditsUsed = Math.ceil(totalTokens / TOKENS_PER_CREDIT);

    // Deduct credits
    await sql`
      UPDATE credits SET
        balance = GREATEST(balance - ${creditsUsed}, 0),
        total_used = total_used + ${creditsUsed},
        updated_at = NOW()
      WHERE user_id = ${user.id}::uuid
    `;

    // Log usage
    await sql`
      INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, credits_deducted, endpoint)
      VALUES (${user.id}::uuid, ${useModel}, ${promptTokens}, ${completionTokens}, ${totalTokens}, ${creditsUsed}, 'chat')
    `;

    return creditsUsed;
  }

  try {
    if (stream) {
      // Streaming mode — SSE
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const response = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: useModel,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          extra_body: { enable_thinking: true },
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        console.error("[chat] Upstream API error:", response.status, errBody.slice(0, 300));
        const userMessage = sanitizeUpstreamError(response.status, errBody);
        res.write(`data: ${JSON.stringify({ error: userMessage })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let promptTokens = 0;
      let completionTokens = 0;
      let streamedContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            // Log usage at the end of stream
            if (promptTokens || completionTokens || streamedContent.length > 0) {
              const estTokens = Math.ceil(streamedContent.length / 4);
              await logUsage(promptTokens || Math.ceil(JSON.stringify(messages).length / 4), completionTokens || estTokens);
            }
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            // Capture usage from final chunk
            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens || 0;
              completionTokens = parsed.usage.completion_tokens || 0;
            }
            const delta = parsed.choices?.[0]?.delta;
            if (delta) {
              if (delta.reasoning_content) {
                res.write(`data: ${JSON.stringify({ type: "thinking", content: delta.reasoning_content })}\n\n`);
              }
              if (delta.content) {
                streamedContent += delta.content;
                res.write(`data: ${JSON.stringify({ type: "content", content: delta.content })}\n\n`);
              }
            }
          } catch {
            // skip malformed SSE chunks
          }
        }
      }

      // Final cleanup if stream ended without [DONE]
      if (streamedContent.length > 0) {
        const estCompletion = Math.ceil(streamedContent.length / 4);
        const estPrompt = Math.ceil(JSON.stringify(messages).length / 4);
        await logUsage(promptTokens || estPrompt, completionTokens || estCompletion);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      // Non-streaming mode
      const response = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: useModel,
          messages,
          extra_body: { enable_thinking: true },
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        console.error("[chat] Upstream API error:", response.status, errBody.slice(0, 300));
        const userMessage = sanitizeUpstreamError(response.status, errBody);
        return res.status(502).json({ error: userMessage });
      }

      const data = await response.json();

      // Log usage
      const usage = data.usage || {};
      const pTokens = usage.prompt_tokens || 0;
      const cTokens = usage.completion_tokens || 0;
      const creditsUsed = await logUsage(pTokens, cTokens);

      // Attach credit info to response
      data._credits = { used: creditsUsed, remaining: Math.max(balance - creditsUsed, 0) };

      return res.json(data);
    }
  } catch (e) {
    console.error("[chat] Unexpected error:", e.message);
    if (stream) {
      try {
        res.write(`data: ${JSON.stringify({ error: "An unexpected error occurred. Please try again." })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch {}
    } else {
      return res.status(500).json({ error: "An unexpected error occurred. Please try again." });
    }
  }
};
