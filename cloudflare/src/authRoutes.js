import { Hono } from "hono";
import { hashPassword, verifyPassword, signJwt } from "./crypto-utils.js";
import { getNumberSetting, adjustBalance, publicUser } from "./store.js";
import { authRequired } from "./middleware.js";

const auth = new Hono();
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function issueToken(user, secret) {
  return signJwt({ uid: user.id }, secret, 7 * 24 * 60 * 60);
}

auth.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, email, password } = body;
  if (!username || !email || !password) {
    return c.json({ error: "username, email, and password are required" }, 400);
  }
  if (!USERNAME_RE.test(username)) {
    return c.json({ error: "Username must be 3-20 characters (letters, numbers, underscore)" }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return c.json({ error: "Enter a valid email address" }, 400);
  }
  if (password.length < 6) {
    return c.json({ error: "Password must be at least 6 characters" }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM users WHERE email = ? OR username = ?"
  ).bind(email, username).first();
  if (existing) return c.json({ error: "Username or email is already registered" }, 409);

  const { hash, salt } = await hashPassword(password);
  const now = new Date().toISOString();
  const info = await c.env.DB.prepare(
    `INSERT INTO users (username, email, password_hash, password_salt, is_verified, is_admin, is_banned, balance, created_at)
     VALUES (?, ?, ?, ?, 1, 0, 0, 0, ?)`
  )
    .bind(username, email, hash, salt, now)
    .run();

  const userId = info.meta.last_row_id;
  const bonus = await getNumberSetting(c.env.DB, "signup_bonus_credits");
  if (bonus > 0) {
    await adjustBalance(c.env.DB, userId, bonus, "signup_bonus", null);
  }

  const freshUser = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  const token = await issueToken(freshUser, c.env.JWT_SECRET);
  return c.json({ token, user: publicUser(freshUser) });
});

auth.post("/login", async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) return c.json({ error: "email and password are required" }, 400);

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
    return c.json({ error: "Invalid email or password" }, 401);
  }
  if (user.is_banned) return c.json({ error: "This account has been banned" }, 403);

  const token = await issueToken(user, c.env.JWT_SECRET);
  return c.json({ token, user: publicUser(user) });
});

auth.get("/me", authRequired, (c) => {
  return c.json({ user: publicUser(c.get("user")) });
});

export default auth;
