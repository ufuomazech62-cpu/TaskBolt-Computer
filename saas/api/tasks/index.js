const { sql, initDB } = require("../_db");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "taskbolt-jwt-secret-change-in-prod";

function getUser(req) {
  const auth = (req.headers.authorization || "").replace("Bearer ", "");
  if (!auth) return null;
  try { return jwt.verify(auth, JWT_SECRET); } catch { return null; }
}

module.exports = async function handler(req, res) {
  try { await initDB(); } catch (e) { return res.status(500).json({ error: "DB init failed" }); }
  if (req.method === "OPTIONS") return res.status(200).end();

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    const q = req.query.q || "";
    let tasks;
    if (q) {
      tasks = await sql`SELECT * FROM tasks WHERE user_id = ${user.sub} AND title ILIKE ${"%" + q + "%"} ORDER BY updated_at DESC LIMIT 50`;
    } else {
      tasks = await sql`SELECT * FROM tasks WHERE user_id = ${user.sub} ORDER BY updated_at DESC LIMIT 50`;
    }
    return res.json({ ok: true, tasks });
  }

  if (req.method === "POST") {
    const { title, messages } = req.body;
    const tasks = await sql`
      INSERT INTO tasks (user_id, title, messages)
      VALUES (${user.sub}, ${title || "New Task"}, ${JSON.stringify(messages || [])})
      RETURNING *
    `;
    return res.json({ ok: true, task: tasks[0] });
  }

  res.status(405).json({ error: "Method not allowed" });
};
