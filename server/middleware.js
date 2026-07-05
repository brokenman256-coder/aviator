const jwt = require("jsonwebtoken");
const config = require("./config");
const db = require("./db");

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.uid);
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

module.exports = { authRequired, adminRequired };
