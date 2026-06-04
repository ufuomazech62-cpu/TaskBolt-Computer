/**
 * Debug endpoint — tests DashScope connectivity
 */
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  
  const results = {};
  
  results.env = {
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY 
      ? `set (${process.env.DASHSCOPE_API_KEY.slice(0, 15)}...)` 
      : "NOT SET",
    DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL || "NOT SET (fallback: intl)",
    NEON_DATABASE_URL: process.env.NEON_DATABASE_URL ? "set" : "NOT SET",
  };
  
  const API_BASE = process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const apiKey = process.env.DASHSCOPE_API_KEY;
  
  if (!apiKey) {
    results.dashscope = { error: "No API key" };
    return res.json(results);
  }
  
  try {
    const start = Date.now();
    const response = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen-plus",
        messages: [{ role: "user", content: "say ok" }],
        max_tokens: 10,
      }),
    });
    
    results.dashscope = {
      status: response.status,
      url: API_BASE + "/chat/completions",
      elapsed_ms: Date.now() - start,
    };
    
    if (response.ok) {
      const data = await response.json();
      results.dashscope.success = true;
      results.dashscope.model = data.model;
      results.dashscope.content = data.choices?.[0]?.message?.content;
    } else {
      results.dashscope.error = (await response.text()).slice(0, 500);
    }
  } catch (e) {
    results.dashscope = { error: e.message };
  }
  
  try {
    const { sql, initDB } = require("../../lib/_db");
    await initDB();
    const users = await sql`SELECT COUNT(*) as count FROM users`;
    const credits = await sql`SELECT user_id, balance, total_used FROM credits ORDER BY created_at DESC LIMIT 5`;
    results.db = { connected: true, user_count: users[0]?.count, credits: credits };
  } catch (e) {
    results.db = { connected: false, error: e.message };
  }
  
  res.json(results);
};
