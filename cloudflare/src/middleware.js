import { verifyJwt } from "./crypto-utils.js";

async function authRequired(c, next) {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "Not authenticated" }, 401);

  try {
    const payload = await verifyJwt(token, c.env.JWT_SECRET);
    const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.uid).first();
    if (!user || user.is_banned) return c.json({ error: "Not authenticated" }, 401);
    c.set("user", user);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired session" }, 401);
  }
}

async function adminRequired(c, next) {
  const user = c.get("user");
  if (!user || !user.is_admin) return c.json({ error: "Admin access required" }, 403);
  await next();
}

export { authRequired, adminRequired };
