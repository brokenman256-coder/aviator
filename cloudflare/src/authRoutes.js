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

function randomReferralCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion
  let code = "";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

async function generateUniqueReferralCode(db) {
  for (let i = 0; i < 5; i++) {
    const code = randomReferralCode();
    const existing = await db.prepare("SELECT id FROM users WHERE referral_code = ?").bind(code).first();
    if (!existing) return code;
  }
  throw new Error("Could not generate a unique referral code, try again");
}

auth.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, email, password, referralCode } = body;
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

  let referredBy = null;
  if (referralCode) {
    const referrer = await c.env.DB.prepare("SELECT id FROM users WHERE referral_code = ?")
      .bind(String(referralCode).trim().toUpperCase()).first();
    if (referrer) referredBy = referrer.id;
  }

  const { hash, salt } = await hashPassword(password);
  const newReferralCode = await generateUniqueReferralCode(c.env.DB);
  const now = new Date().toISOString();
  const info = await c.env.DB.prepare(
    `INSERT INTO users (username, email, password_hash, password_salt, is_verified, is_admin, is_banned, balance, created_at, referral_code, referred_by)
     VALUES (?, ?, ?, ?, 1, 0, 0, 0, ?, ?, ?)`
  )
    .bind(username, email, hash, salt, now, newReferralCode, referredBy)
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
