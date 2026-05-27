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

  const id = req.query.id;

  // GET single task
  if (req.method === "GET") {
    const tasks = await sql`SELECT * FROM tasks WHERE id = ${id} AND user_id = ${user.sub}`;
    if (!tasks.length) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true, task: tasks[0] });
  }

  // PUT update task
  if (req.method === "PUT") {
    const { title, messages } = req.body;
    const tasks = await sql`
      UPDATE tasks SET
        title = COALESCE(${title}, title),
        messages = COALESCE(${JSON.stringify(messages)}, messages),
        updated_at = NOW()
      WHERE id = ${id} AND user_id = ${user.sub}
      RETURNING *
    `;
    if (!tasks.length) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true, task: tasks[0] });
  }

  // DELETE task
  if (req.method === "DELETE") {
    await sql`DELETE FROM tasks WHERE id = ${id} AND user_id = ${user.sub}`;
    return res.json({ ok: true });
  }

  res.status(405).json({ error: "Method not allowed" });
}
