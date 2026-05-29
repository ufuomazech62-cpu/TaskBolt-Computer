/**
 * TaskBolt Chat API — Authenticated + Credit-based
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

  const { messages, model, stream } = req.body;
  if (!messages || !messages.length) return jsonResponse(res, { error: "messages required" }, 400);

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return jsonResponse(res, { error: "DASHSCOPE_API_KEY not configured" }, 500);

  const useModel = model || "qwen3.6-flash";

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
        const err = await response.text();
        res.write(`data: ${JSON.stringify({ error: err.slice(0, 500) })}\n\n`);
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
        const err = await response.text();
        return res.status(response.status).json({ error: err.slice(0, 500) });
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
    if (stream) {
      try {
        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch {}
    } else {
      return res.status(500).json({ error: e.message });
    }
  }
};
