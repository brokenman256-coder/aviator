const jwt = require("jsonwebtoken");
const config = require("./config");
const db = require("./db");

async function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [payload.uid]);
    const user = rows[0];
    if (!user || user.is_banned) return res.status(401).json({ error: "Not authenticated" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

function adminRequired(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// Express 4 doesn't catch rejected promises from async handlers on its own —
// wrap every route with this so a thrown/rejected error reaches the error
// handler instead of hanging the request.
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { authRequired, adminRequired, ah };
