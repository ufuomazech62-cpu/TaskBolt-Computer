const API_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { messages, model } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: "messages required" });

  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.DASHSCOPE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || "qwen3.6-plus",
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
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
