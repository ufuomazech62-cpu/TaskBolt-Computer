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
    const skills = await sql`SELECT * FROM user_skills WHERE user_id = ${user.sub} ORDER BY created_at`;
    return res.json({ ok: true, skills });
  }

  if (req.method === "POST") {
    const { name, description, config } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const skills = await sql`
      INSERT INTO user_skills (user_id, name, description, config)
      VALUES (${user.sub}, ${name}, ${description || ""}, ${JSON.stringify(config || {})})
      RETURNING *
    `;
    return res.json({ ok: true, skill: skills[0] });
  }

  res.status(405).json({ error: "Method not allowed" });
};
