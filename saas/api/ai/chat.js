const API_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { messages, model, stream } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: "messages required" });

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "DASHSCOPE_API_KEY not configured" });

  const useModel = model || "qwen3.6-flash";

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
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta) {
              // Forward reasoning_content for thinking phase
              if (delta.reasoning_content) {
                res.write(`data: ${JSON.stringify({ type: "thinking", content: delta.reasoning_content })}\n\n`);
              }
              if (delta.content) {
                res.write(`data: ${JSON.stringify({ type: "content", content: delta.content })}\n\n`);
              }
            }
          } catch {
            // skip malformed SSE chunks
          }
        }
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
