import { Hono } from "hono";
import { hashPassword, verifyPassword, signJwt } from "./crypto-utils.js";
import { generateCode, sendOtp } from "./otp.js";
import { getNumberSetting, adjustBalance, publicUser } from "./store.js";
import { authRequired } from "./middleware.js";

const auth = new Hono();
const OTP_TTL_MS = 10 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9]{7,15}$/;

function normalizePhone(phone) {
  return String(phone || "").replace(/[^0-9]/g, "");
}

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

async function createAndSendOtp(db, userId, email) {
  const code = generateCode();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  await db
    .prepare("INSERT INTO otp_codes (user_id, code, expires_at, consumed, created_at) VALUES (?, ?, ?, 0, ?)")
    .bind(userId, code, expiresAt, now)
    .run();
  const { delivered } = await sendOtp(email, code);
  return { delivered, devCode: delivered ? undefined : code };
}

auth.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, email, password, referralCode } = body;
  const phone = normalizePhone(body.phone);
  if (!username || !email || !password || !phone) {
    return c.json({ error: "username, email, password, and phone number are required" }, 400);
  }
  if (!USERNAME_RE.test(username)) {
    return c.json({ error: "Username must be 3-20 characters (letters, numbers, underscore)" }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return c.json({ error: "Enter a valid email address" }, 400);
  }
  if (!PHONE_RE.test(phone)) {
    return c.json({ error: "Enter a valid phone number (digits only, 7-15 digits)" }, 400);
  }
  if (password.length < 6) {
    return c.json({ error: "Password must be at least 6 characters" }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM users WHERE email = ? OR username = ? OR phone = ?"
  ).bind(email, username, phone).first();
  if (existing) return c.json({ error: "Username, email, or phone number is already registered" }, 409);

  let referredBy = null;
  if (referralCode) {
    const referrer = await c.env.DB.prepare("SELECT id FROM users WHERE referral_code = ?").bind(referralCode.trim().toUpperCase()).first();
    if (referrer) referredBy = referrer.id;
  }

  const { hash, salt } = await hashPassword(password);
  const newReferralCode = await generateUniqueReferralCode(c.env.DB);
  const now = new Date().toISOString();
  const info = await c.env.DB.prepare(
    `INSERT INTO users (username, email, phone, password_hash, password_salt, is_verified, is_admin, is_banned, balance, created_at, referral_code, referred_by)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?)`
  )
    .bind(username, email, phone, hash, salt, now, newReferralCode, referredBy)
    .run();

  const userId = info.meta.last_row_id;
  const { delivered, devCode } = await createAndSendOtp(c.env.DB, userId, email);
  return c.json({
    userId,
    message: delivered
      ? "Verification code sent to your email."
      : "Email delivery isn't configured, so here's your code directly.",
    devCode,
  });
});

auth.post("/resend-otp", async (c) => {
  const { userId } = await c.req.json().catch(() => ({}));
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.is_verified) return c.json({ error: "Account is already verified" }, 400);

  const { delivered, devCode } = await createAndSendOtp(c.env.DB, user.id, user.email);
  return c.json({
    message: delivered ? "Code resent." : "Email delivery isn't configured, so here's your code directly.",
    devCode,
  });
});

auth.post("/verify-otp", async (c) => {
  const { userId, code } = await c.req.json().catch(() => ({}));
  if (!userId || !code) return c.json({ error: "userId and code are required" }, 400);

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.is_verified) return c.json({ error: "Account is already verified" }, 400);

  const otp = await c.env.DB.prepare(
    "SELECT * FROM otp_codes WHERE user_id = ? AND code = ? AND consumed = 0 ORDER BY id DESC LIMIT 1"
  )
    .bind(userId, code)
    .first();
  if (!otp) return c.json({ error: "Incorrect code" }, 400);
  if (new Date(otp.expires_at).getTime() < Date.now()) {
    return c.json({ error: "Code expired, request a new one" }, 400);
  }
  await c.env.DB.prepare("UPDATE otp_codes SET consumed = 1 WHERE id = ?").bind(otp.id).run();

  const bonus = await getNumberSetting(c.env.DB, "signup_bonus_credits");
  await c.env.DB.prepare("UPDATE users SET is_verified = 1 WHERE id = ?").bind(userId).run();
  if (bonus > 0) {
    await adjustBalance(c.env.DB, userId, bonus, "signup_bonus", null);
  }

  if (user.referred_by) {
    const referralBonus = await getNumberSetting(c.env.DB, "referral_bonus_credits");
    if (referralBonus > 0) {
      // Both sides of a successful referral get the same bonus once the new
      // account actually verifies (not just registers), so referrals can't be
      // farmed with throwaway unverified signups.
      await adjustBalance(c.env.DB, userId, referralBonus, "referral_bonus", { referredBy: user.referred_by });
      await adjustBalance(c.env.DB, user.referred_by, referralBonus, "referral_bonus", { referredUser: userId });
    }
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
  if (!user.is_verified) {
    return c.json(
      {
        error: "Please verify your account with the code sent during registration",
        needsVerification: true,
        userId: user.id,
      },
      403
    );
  }

  const token = await issueToken(user, c.env.JWT_SECRET);
  return c.json({ token, user: publicUser(user) });
});

auth.get("/me", authRequired, (c) => {
  return c.json({ user: publicUser(c.get("user")) });
});

export default auth;
