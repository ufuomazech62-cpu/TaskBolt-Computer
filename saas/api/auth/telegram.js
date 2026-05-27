const { sql, initDB } = require("../_db");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "taskbolt-jwt-secret-change-in-prod";

module.exports = async function handler(req, res) {
  try {
    await initDB();
  } catch (e) {
    return res.status(500).json({ error: "DB init failed: " + e.message });
  }

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "POST") {
    const { telegram_id, username, first_name, last_name } = req.body;
    if (!telegram_id) return res.status(400).json({ error: "telegram_id required" });

    const displayName = [first_name, last_name].filter(Boolean).join(" ") || null;

    try {
      const users = await sql`
        INSERT INTO users (telegram_id, username, display_name)
        VALUES (${telegram_id}, ${username || null}, ${displayName})
        ON CONFLICT (telegram_id) DO UPDATE SET
          username = EXCLUDED.username,
          display_name = EXCLUDED.display_name,
          updated_at = NOW()
        RETURNING *
      `;
      const user = users[0];
      const token = jwt.sign(
        { sub: user.id, telegram_id: user.telegram_id },
        JWT_SECRET,
        { expiresIn: "365d" }
      );
      return res.json({ ok: true, user: { id: user.id, username: user.username, display_name: user.display_name }, token });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "GET") {
    const auth = (req.headers.authorization || "").replace("Bearer ", "");
    if (!auth) return res.status(401).json({ error: "No token" });
    try {
      const decoded = jwt.verify(auth, JWT_SECRET);
      const users = await sql`SELECT id, telegram_id, username, display_name, created_at FROM users WHERE id = ${decoded.sub}`;
      if (!users.length) return res.status(404).json({ error: "User not found" });
      return res.json({ ok: true, user: users[0] });
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
