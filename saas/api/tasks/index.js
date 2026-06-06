const { requireAuth, jsonResponse } = require("../../lib/_auth");
const { sql, initDB } = require("../../lib/_db");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  await initDB();

  const user = requireAuth(req);
  if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);

  // --- Skills endpoint (routed via rewrite from /api/skills) ---
  if (req.query._route === 'skills' || req.headers['x-route'] === 'skills') {
    if (req.method === "GET") {
      const skills = await sql`SELECT * FROM user_skills WHERE user_id = ${user.id}::uuid ORDER BY created_at`;
      return jsonResponse(res, { ok: true, skills });
    }
    if (req.method === "POST") {
      const { name, description, config } = req.body || {};
      if (!name) return jsonResponse(res, { error: "name required" }, 400);
      const skills = await sql`
        INSERT INTO user_skills (user_id, name, description, config)
        VALUES (${user.id}::uuid, ${name}, ${description || ""}, ${JSON.stringify(config || {})})
        RETURNING *
      `;
      return jsonResponse(res, { ok: true, skill: skills[0] });
    }
    return jsonResponse(res, { error: "Method not allowed" }, 405);
  }

  const id = req.query.id; // If present, operate on single task

  // --- Single task operations (when ?id= is provided) ---
  if (id) {
    if (req.method === "GET") {
      const tasks = await sql`SELECT * FROM tasks WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
      if (!tasks.length) return jsonResponse(res, { error: "Not found" }, 404);
      return jsonResponse(res, { ok: true, task: tasks[0] });
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      const { title, messages } = req.body || {};
      const tasks = await sql`UPDATE tasks SET title = COALESCE(${title || null}, title), messages = COALESCE(${JSON.stringify(messages || null)}::jsonb, messages), updated_at = NOW() WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid RETURNING *`;
      if (!tasks.length) return jsonResponse(res, { error: "Not found" }, 404);
      return jsonResponse(res, { ok: true, task: tasks[0] });
    }
    if (req.method === "DELETE") {
      await sql`DELETE FROM tasks WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
      return jsonResponse(res, { ok: true });
    }
    return jsonResponse(res, { error: "Method not allowed" }, 405);
  }

  // --- List/Create tasks (no ?id=) ---
  if (req.method === "GET") {
    const q = req.query.q || "";
    let tasks;
    if (q) {
      tasks = await sql`SELECT * FROM tasks WHERE user_id = ${user.id}::uuid AND title ILIKE ${"%" + q + "%"} ORDER BY updated_at DESC LIMIT 50`;
    } else {
      tasks = await sql`SELECT * FROM tasks WHERE user_id = ${user.id}::uuid ORDER BY updated_at DESC LIMIT 50`;
    }
    return jsonResponse(res, { ok: true, tasks });
  }

  if (req.method === "POST") {
    const { title, messages } = req.body || {};
    const tasks = await sql`INSERT INTO tasks (user_id, title, messages) VALUES (${user.id}::uuid, ${title || "New Task"}, ${JSON.stringify(messages || [])}::jsonb) RETURNING *`;
    return jsonResponse(res, { ok: true, task: tasks[0] });
  }

  return jsonResponse(res, { error: "Method not allowed" }, 405);
};
