const { verify } = require("./_jwt");

function requireAuth(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const payload = verify(token);
  if (!payload) return null;
  // JWT stores userId, but all endpoints use user.id — alias it
  return { ...payload, id: payload.userId || payload.id };
}

function setCorsHeaders(res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function jsonResponse(res, data, status = 200) {
  setCorsHeaders(res);
  res.status(status).json(data);
}

module.exports = { requireAuth, setCorsHeaders, jsonResponse };
