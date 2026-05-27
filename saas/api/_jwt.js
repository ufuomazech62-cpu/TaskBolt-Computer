const crypto = require("crypto");

const SECRET = process.env.JWT_SECRET || "taskbolt-jwt-s3cr3t-2026";

function b64url(buf) {
  return buf.toString("base64url");
}

function sign(payload) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const pl = b64url(Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 86400*365 })));
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(header + "." + pl).digest());
  return header + "." + pl + "." + sig;
}

function verify(token) {
  try {
    const [h, p, s] = token.split(".");
    const expected = b64url(crypto.createHmac("sha256", SECRET).update(h + "." + p).digest());
    if (s !== expected) return null;
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

module.exports = { sign, verify };
