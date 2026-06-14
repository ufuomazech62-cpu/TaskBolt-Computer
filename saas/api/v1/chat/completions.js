/**
 * TaskBolt OpenAI-Compatible Proxy — /api/v1/chat/completions
 *
 * This endpoint is used by the local Hermes gateway as its model provider.
 * It provides a standard OpenAI-compatible interface while enforcing:
 *   - JWT authentication (user must be signed in)
 *   - Credit deduction (1 credit = 200 tokens)
 *   - API key security (DashScope key stays on server)
 *
 * Architecture:
 *   User → Tauri App → Local Hermes Gateway (tools, memory, terminal)
 *     → This endpoint (auth + credits) → DashScope (AI model)
 *     → Back to gateway → tool execution → back to user
 *
 * Everything runs locally via the gateway (full Hermes capabilities).
 * Only the model API call goes through this SaaS proxy for billing.
 */

const { requireAuth, jsonResponse, setCorsHeaders } = require("../../../lib/_auth");
const { sql, initDB } = require("../../../lib/_db");

const API_BASE = process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const TOKENS_PER_CREDIT = 200;

// Supported models — fallback to qwen-plus for unknown
const VALID_MODELS = ["deepseek-v4-flash", "qwen-plus", "qwen-max", "qwen-turbo"];

function sanitizeUpstreamError(status, rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const code = parsed.error?.code || parsed.code || "";
    if (status === 429 || code === "RateLimitReached" || code === "Throttling") {
      return { status: 429, message: "High demand right now. Please try again in a moment." };
    }
    if (code === "Arrearage" || code === "InsufficientBalance" || rawBody.includes("overdue")) {
      return { status: 503, message: "Service temporarily unavailable. Please try again shortly." };
    }
    if (status === 401 || status === 403 || code === "InvalidApiKey") {
      return { status: 500, message: "Service configuration error. Our team has been notified." };
    }
    if (code === "ModelNotFound" || code === "InvalidModel") {
      return { status: 400, message: "Model temporarily unavailable. Please try again." };
    }
  } catch {}
  if (status === 429) return { status: 429, message: "Too many requests. Please wait a moment." };
  if (status >= 500) return { status: 502, message: "AI service temporarily unavailable. Please try again." };
  return { status: 502, message: "Something went wrong. Please try again." };
}

function extractModel(modelStr) {
  if (!modelStr) return "qwen-plus";
  // Strip provider prefix: "taskbolt:deepseek-v4-flash" → "deepseek-v4-flash"
  const parts = modelStr.split(":");
  const name = parts.length > 1 ? parts[parts.length - 1] : modelStr;
  return VALID_MODELS.includes(name) ? name : "qwen-plus";
}

module.exports = async function handler(req, res) {
  // CORS
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    setCorsHeaders(res);
    return res.status(405).json({ error: { message: "POST only", type: "invalid_request_error" } });
  }

  // ═══ AUTH — JWT or API Key ═══
  const authHeader = req.headers["authorization"] || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  
  let user = null;
  
  if (bearerToken.startsWith("tb_")) {
    // API Key authentication (desktop app)
    await initDB();
    
    // Ensure api_keys table exists
    await sql`
      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        name TEXT DEFAULT 'Default',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        last_used_at TIMESTAMP
      )
    `;
    
    const crypto = require("crypto");
    const keyHash = crypto.createHash("sha256").update(bearerToken).digest("hex");
    const keyRow = await sql`
      SELECT ak.*, u.id as uid, u.email 
      FROM api_keys ak 
      JOIN users u ON ak.user_id = u.id 
      WHERE ak.key_hash = ${keyHash} AND ak.is_active = true 
      LIMIT 1
    `;
    
    if (!keyRow.length) {
      setCorsHeaders(res);
      return res.status(401).json({
        error: { message: "Invalid API key. Get your key at taskbolt.space/dashboard", type: "authentication_error" }
      });
    }
    
    // Update last_used_at
    await sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${keyRow[0].id}::uuid`;
    
    user = { id: keyRow[0].uid, email: keyRow[0].email };
  } else {
    // JWT authentication (web/gateway)
    user = requireAuth(req);
    if (!user) {
      setCorsHeaders(res);
      return res.status(401).json({
        error: { message: "Unauthorized — valid JWT token or API key required", type: "authentication_error" }
      });
    }
    await initDB();
  }

  // ═══ CREDIT CHECK ═══
  const credRows = await sql`SELECT balance FROM credits WHERE user_id = ${user.id}::uuid`;
  let balance = credRows[0]?.balance || 0;
  if (balance <= 0) {
    setCorsHeaders(res);
    return res.status(402).json({
      error: {
        message: "No credits remaining. Purchase a credit pack to continue.",
        type: "insufficient_credits",
        code: "no_credits"
      }
    });
  }

  const { messages, model, tools, tool_choice, stream, stream_options } = req.body;
  if (!messages || !messages.length) {
    setCorsHeaders(res);
    return res.status(400).json({
      error: { message: "messages array is required", type: "invalid_request_error" }
    });
  }

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    setCorsHeaders(res);
    return res.status(500).json({
      error: { message: "Service configuration error", type: "server_error" }
    });
  }

  const useModel = extractModel(model);

  // Build DashScope request — pass through tools from Hermes gateway
  const dashBody = {
    model: useModel,
    messages,
    stream: !!stream,
  };

  if (tools && tools.length > 0) {
    dashBody.tools = tools;
    if (tool_choice) dashBody.tool_choice = tool_choice;
  }

  if (stream) {
    dashBody.stream_options = { include_usage: true };
  }

  // ═══ CREDIT DEDUCTION ═══
  async function deductCredits(promptTokens, completionTokens) {
    const totalTokens = promptTokens + completionTokens;
    if (totalTokens <= 0) return 0;
    const creditsUsed = Math.max(1, Math.ceil(totalTokens / TOKENS_PER_CREDIT));

    await sql`
      UPDATE credits SET
        balance = GREATEST(balance - ${creditsUsed}, 0),
        total_used = total_used + ${creditsUsed},
        updated_at = NOW()
      WHERE user_id = ${user.id}::uuid
    `;

    await sql`
      INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, credits_deducted, endpoint)
      VALUES (${user.id}::uuid, ${useModel}, ${promptTokens}, ${completionTokens}, ${totalTokens}, ${creditsUsed}, 'gateway')
    `;

    balance = Math.max(balance - creditsUsed, 0);
    return creditsUsed;
  }

  // ═══ CALL DASHSCOPE ═══
  try {
    let response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(dashBody),
    });

    // Retry with fallback model on model errors
    if (!response.ok && (response.status === 400 || response.status === 404)) {
      const errBody = await response.text();
      try {
        const parsed = JSON.parse(errBody);
        const code = parsed.error?.code || "";
        if (code === "ModelNotFound" || code === "InvalidModel" || errBody.includes("model")) {
          console.log(`[gateway-proxy] ${useModel} failed, retrying with qwen-plus`);
          dashBody.model = "qwen-plus";
          response = await fetch(`${API_BASE}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(dashBody),
          });
        }
      } catch {}
    }

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[gateway-proxy] Upstream ${response.status}:`, errBody.slice(0, 300));
      const sanitized = sanitizeUpstreamError(response.status, errBody);
      setCorsHeaders(res);
      return res.status(sanitized.status).json({
        error: { message: sanitized.message, type: "upstream_error" }
      });
    }

    // ═══ STREAMING ═══
    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let promptTokens = 0;
      let completionTokens = 0;
      let creditsDeducted = false;

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

            if (trimmed.startsWith("data:")) {
              const data = trimmed.slice(5).trim();

              if (data === "[DONE]") {
                // Deduct credits before closing stream
                if (!creditsDeducted && (promptTokens > 0 || completionTokens > 0)) {
                  await deductCredits(promptTokens, completionTokens);
                  creditsDeducted = true;
                }
                res.write("data: [DONE]\n\n");
                res.end();
                return;
              }

              // Parse to capture usage from final chunk
              try {
                const parsed = JSON.parse(data);
                if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens || 0;
                  completionTokens = parsed.usage.completion_tokens || 0;
                }
              } catch {}

              // Pass through chunk as-is (OpenAI SSE format)
              res.write(`${trimmed}\n\n`);
            }
          }
        }

        // Stream ended without [DONE]
        if (!creditsDeducted && (promptTokens > 0 || completionTokens > 0)) {
          await deductCredits(promptTokens, completionTokens);
        }
        res.write("data: [DONE]\n\n");
        res.end();

      } catch (streamErr) {
        console.error("[gateway-proxy] Stream error:", streamErr.message);
        if (!creditsDeducted && (promptTokens > 0 || completionTokens > 0)) {
          await deductCredits(promptTokens, completionTokens).catch(() => {});
        }
        try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
      }

    } else {
      // ═══ NON-STREAMING ═══
      const data = await response.json();

      const usage = data.usage || {};
      const pTokens = usage.prompt_tokens || 0;
      const cTokens = usage.completion_tokens || 0;
      const creditsUsed = await deductCredits(pTokens, cTokens);

      // Attach credit info for the gateway/frontend
      data._credits = { used: creditsUsed, remaining: balance };

      setCorsHeaders(res);
      return res.json(data);
    }

  } catch (e) {
    console.error("[gateway-proxy] Unexpected error:", e.message);
    setCorsHeaders(res);
    return res.status(500).json({
      error: { message: "An unexpected error occurred. Please try again.", type: "server_error" }
    });
  }
};
