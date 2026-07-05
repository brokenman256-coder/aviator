const express = require("express");
const jwt = require("jsonwebtoken");

const db = require("./db");
const config = require("./config");
const { hashPassword, verifyPassword } = require("./crypto-utils");
const { generateCode, sendOtp } = require("./otp");
const { getNumberSetting, adjustBalance, publicUser } = require("./store");
const { authRequired } = require("./middleware");

const router = express.Router();
const OTP_TTL_MS = 10 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function issueToken(user) {
  return jwt.sign({ uid: user.id }, config.JWT_SECRET, { expiresIn: "7d" });
}

function createAndSendOtp(userId, email) {
  const code = generateCode();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO otp_codes (user_id, code, expires_at, consumed, created_at) VALUES (?, ?, ?, 0, ?)"
  ).run(userId, code, expiresAt, now);
  return sendOtp(email, code).then(({ delivered }) => ({
    delivered,
    devCode: delivered ? undefined : code,
  }));
}

router.post("/register", async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: "username, email, and password are required" });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "Username must be 3-20 characters (letters, numbers, underscore)" });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ? OR username = ?").get(email, username);
  if (existing) return res.status(409).json({ error: "Username or email already registered" });

  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (username, email, password_hash, password_salt, is_verified, is_admin, is_banned, balance, created_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)`
    )
    .run(username, email, hash, salt, now);

  const { delivered, devCode } = await createAndSendOtp(info.lastInsertRowid, email);
  res.json({
    userId: info.lastInsertRowid,
    message: delivered
      ? "Verification code sent to your email."
      : "SMTP isn't configured, so check the server console for your verification code.",
    devCode,
  });
});

router.post("/resend-otp", async (req, res) => {
  const { userId } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.is_verified) return res.status(400).json({ error: "Account is already verified" });

  const { delivered, devCode } = await createAndSendOtp(user.id, user.email);
  res.json({
    message: delivered ? "Code resent." : "SMTP isn't configured, so check the server console.",
    devCode,
  });
});

router.post("/verify-otp", (req, res) => {
  const { userId, code } = req.body || {};
  if (!userId || !code) return res.status(400).json({ error: "userId and code are required" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.is_verified) return res.status(400).json({ error: "Account is already verified" });

  const otp = db
    .prepare(
      "SELECT * FROM otp_codes WHERE user_id = ? AND code = ? AND consumed = 0 ORDER BY id DESC LIMIT 1"
    )
    .get(userId, code);
  if (!otp) return res.status(400).json({ error: "Incorrect code" });
  if (new Date(otp.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: "Code expired, request a new one" });
  }
  db.prepare("UPDATE otp_codes SET consumed = 1 WHERE id = ?").run(otp.id);

  const bonus = getNumberSetting("signup_bonus_credits");
  db.prepare("UPDATE users SET is_verified = 1 WHERE id = ?").run(userId);
  if (bonus > 0) {
    adjustBalance(userId, bonus, "signup_bonus", null);
  }

  const freshUser = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const token = issueToken(freshUser);
  res.json({ token, user: publicUser(freshUser) });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  if (user.is_banned) return res.status(403).json({ error: "This account has been banned" });
  if (!user.is_verified) {
    return res.status(403).json({
      error: "Please verify your account with the code sent during registration",
      needsVerification: true,
      userId: user.id,
    });
  }

  const token = issueToken(user);
  res.json({ token, user: publicUser(user) });
});

router.get("/me", authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = router;
