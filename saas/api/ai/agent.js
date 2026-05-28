/**
 * TaskBolt Agent API — Tool-calling endpoint
 * Receives messages + tool definitions from local agent
 * Forwards to DashScope with tools support
 * API key stays on server — users can never access it
 */

const API_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { messages, tools, model } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: "messages required" });

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "DASHSCOPE_API_KEY not configured" });

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
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
