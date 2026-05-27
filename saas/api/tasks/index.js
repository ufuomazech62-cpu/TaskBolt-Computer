import { sql, initDB } from "../_db.js";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "taskbolt-jwt-secret-change-in-prod";

function getUser(req) {
  const auth = req.headers.authorization?.replace("Bearer ", "");
  if (!auth) return null;
  try {
    return jwt.verify(auth, JWT_SECRET);
  } catch { return null; }
}

export default async function handler(req, res) {
  await initDB();
  if (req.method === "OPTIONS") return res.status(200).end();

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  // GET /api/tasks — list all tasks
  if (req.method === "GET") {
    const q = req.query.q || "";
    let tasks;
    if (q) {
      tasks = await sql`
        SELECT * FROM tasks
        WHERE user_id = ${user.sub}
          AND to_tsvector('english', title) @@ plainto_tsquery('english', ${q})
        ORDER BY updated_at DESC LIMIT 50
      `;
    } else {
      tasks = await sql`
        SELECT * FROM tasks
        WHERE user_id = ${user.sub}
        ORDER BY updated_at DESC LIMIT 50
      `;
    }
    return res.json({ ok: true, tasks });
  }

  // POST /api/tasks — create task
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
}
