/**
 * TaskBolt Gateway Proxy — OpenAI-compatible endpoint for desktop app
 * Routes local OpenClaw gateway requests through Vercel
 * Auth: gateway secret (shared) + user JWT via ?token= for per-user credit deduction
 * Credits: deducted per-request from the authenticated user's balance
 * Security: DashScope API key NEVER leaves Vercel
 */

const { sql, initDB } = require("../../../lib/_db");
const { verify } = require("../../../lib/_jwt");

const API_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const TOKENS_PER_CREDIT = 200;
const GATEWAY_SECRET = process.env.TASKBOLT_GATEWAY_SECRET || "taskbolt-gw-secret-2026";

// Valid models
const VALID_MODELS = ["deepseek-v4-flash", "qwen-plus", "qwen-max", "qwen-turbo", "qwen3-max", "qwen3-coder-plus"];

function sanitizeUpstreamError(status, rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const code = parsed.error?.code || parsed.code || "";
    if (status === 429 || code === "RateLimitReached" || code === "Throttling") {
      return "High demand right now. Please try again in a moment.";
    }
    if (code === "Arrearage" || code === "InsufficientBalance" || rawBody.includes("overdue")) {
      return "Service temporarily unavailable. Please try again shortly.";
    }
    if (status === 401 || status === 403 || code === "InvalidApiKey") {
      return "Service configuration error. Our team has been notified.";
    }
    if (code === "ModelNotFound" || code === "InvalidModel") {
      return "Service temporarily unavailable. Please try again.";
    }
  } catch {}
  if (status === 429) return "Too many requests. Please wait a moment.";
  if (status >= 500) return "Service temporarily unavailable. Please try again.";
  return "Something went wrong. Please try again.";
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Auth: check gateway secret (shared between desktop app and Vercel)
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== GATEWAY_SECRET) {
    return res.status(401).json({ error: { message: "Unauthorized", type: "invalid_request_error", code: "invalid_api_key" } });
  }

  // Extract user JWT from custom header for per-user credit deduction
  let userId = null;
  const userToken = req.headers["x-user-token"] || "";
  if (userToken) {
    const payload = verify(userToken);
    if (payload) userId = payload.userId || payload.id;
  }

  // Pre-check: block requests if user has no credits
  if (userId) {
    await initDB();
    const credRows = await sql`SELECT balance FROM credits WHERE user_id = ${userId}::uuid`;
    const balance = credRows[0]?.balance || 0;
    if (balance <= 0) {
      return res.status(402).json({
        error: {
          message: "No credits remaining",
          type: "payment_required",
          code: "insufficient_credits",
        },
        credits: 0,
        rateLimited: true,
      });
    }
  }

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: "Service unavailable", type: "server_error" } });

  const { messages, model, stream, tools, tool_choice, enable_thinking } = req.body;
  if (!messages || !messages.length) {
    return res.status(400).json({ error: { message: "messages required", type: "invalid_request_error" } });
  }

  const useModel = VALID_MODELS.includes(model) ? model : "qwen-plus";

  // Build upstream request body
  const upstreamBody = {
    model: useModel,
    messages,
    stream: !!stream,
  };

  if (stream) {
    upstreamBody.stream_options = { include_usage: true };
  }

  if (tools && tools.length > 0) {
    upstreamBody.tools = tools;
    upstreamBody.tool_choice = tool_choice || "auto";
  }

  // Enable thinking for supported models
  if (enable_thinking || useModel.includes("deepseek")) {
    upstreamBody.extra_body = { enable_thinking: true };
  }

  try {
    await initDB();

    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(upstreamBody),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error("[gateway-proxy] Upstream error:", response.status, errBody.slice(0, 300));

      // Try fallback model
      if ((response.status === 400 || response.status === 404) && useModel !== "qwen-plus") {
        upstreamBody.model = "qwen-plus";
        const retry = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(upstreamBody),
        });
        if (retry.ok) {
          // Continue with retry response
          return handleResponse(res, retry, stream, useModel, userId);
        }
      }

      const userMsg = sanitizeUpstreamError(response.status, errBody);
      return res.status(502).json({ error: { message: userMsg, type: "upstream_error" } });
    }

    return handleResponse(res, response, stream, useModel, userId);
  } catch (e) {
    console.error("[gateway-proxy] Error:", e.message);
    return res.status(500).json({ error: { message: "Internal error", type: "server_error" } });
  }
};

async function handleResponse(res, response, stream, model, userId) {
  if (stream) {
    // SSE streaming
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          res.write(trimmed + "\n\n");

          if (trimmed.startsWith("data:")) {
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") {
              // Log usage and deduct credits
              if (promptTokens || completionTokens) {
                await logGatewayUsage(model, promptTokens, completionTokens, userId);
              }
              res.end();
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.usage) {
                promptTokens = parsed.usage.prompt_tokens || 0;
                completionTokens = parsed.usage.completion_tokens || 0;
              }
            } catch {}
          }
        }
      }
    } catch (e) {
      console.error("[gateway-proxy] Stream error:", e.message);
    }

    // Final cleanup
    if (promptTokens || completionTokens) {
      await logGatewayUsage(model, promptTokens, completionTokens, userId);
    }
    res.end();
  } else {
    // Non-streaming
    const data = await response.json();
    const usage = data.usage || {};
    await logGatewayUsage(model, usage.prompt_tokens || 0, usage.completion_tokens || 0, userId);
    return res.json(data);
  }
}

async function logGatewayUsage(model, promptTokens, completionTokens, userId) {
  try {
    const totalTokens = promptTokens + completionTokens;
    const creditsUsed = Math.ceil(totalTokens / TOKENS_PER_CREDIT);

    if (userId && creditsUsed > 0) {
      // Deduct credits from the authenticated user
      await sql`
        UPDATE credits SET
          balance = GREATEST(balance - ${creditsUsed}, 0),
          total_used = total_used + ${creditsUsed},
          updated_at = NOW()
        WHERE user_id = ${userId}::uuid
      `;

      // Log usage for the user
      await sql`
        INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, credits_deducted, endpoint)
        VALUES (${userId}::uuid, ${model}, ${promptTokens}, ${completionTokens}, ${totalTokens}, ${creditsUsed}, 'desktop-gateway')
      `;
    } else if (!userId) {
      // No user JWT — log to service account
      await sql`
        INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, credits_deducted, endpoint)
        SELECT id, ${model}, ${promptTokens}, ${completionTokens}, ${totalTokens}, ${creditsUsed}, 'desktop-gateway'
        FROM users WHERE email = 'service@taskbolt.space'
        LIMIT 1
      `;
    }
  } catch (e) {
    console.error("[gateway-proxy] Usage log error:", e.message);
  }
}
