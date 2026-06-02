/**
 * TEMP DEBUG: Test DashScope connection without auth
 */

module.exports = async function handler(req, res) {
  const API_BASE = process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const apiKey = process.env.DASHSCOPE_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "DASHSCOPE_API_KEY not set" });
  }

  const body = {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "say hi" }],
  };

  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    
    return res.json({
      status: response.status,
      apiBase: API_BASE,
      model: "deepseek-v4-flash",
      apiKeyPrefix: apiKey.substring(0, 10) + "...",
      response: text,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, apiBase: API_BASE });
  }
};
