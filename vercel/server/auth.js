const express = require("express");
const jwt = require("jsonwebtoken");

const db = require("./db");
const config = require("./config");
const { hashPassword, verifyPassword } = require("./crypto-utils");
const { generateCode, sendOtp } = require("./otp");
const { getNumberSetting, adjustBalance, publicUser } = require("./store");
const { authRequired, ah } = require("./middleware");

const router = express.Router();
const OTP_TTL_MS = 10 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function issueToken(user) {
  return jwt.sign({ uid: user.id }, config.JWT_SECRET, { expiresIn: "7d" });
}

async function createAndSendOtp(userId, email) {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  await db.query(
    "INSERT INTO otp_codes (user_id, code, expires_at, consumed, created_at) VALUES ($1, $2, $3, false, now())",
    [userId, code, expiresAt]
  );
  const { delivered } = await sendOtp(email, code);
  return { delivered, devCode: delivered ? undefined : code };
}

router.post(
  "/register",
  ah(async (req, res) => {
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

    const { rows: existing } = await db.query("SELECT id FROM users WHERE email = $1 OR username = $2", [email, username]);
    if (existing.length) return res.status(409).json({ error: "Username or email already registered" });

    const { hash, salt } = hashPassword(password);
    const { rows } = await db.query(
      `INSERT INTO users (username, email, password_hash, password_salt, is_verified, is_admin, is_banned, balance, created_at)
       VALUES ($1, $2, $3, $4, false, false, false, 0, now()) RETURNING id`,
      [username, email, hash, salt]
    );

    const { delivered, devCode } = await createAndSendOtp(rows[0].id, email);
    res.json({
      userId: rows[0].id,
      message: delivered ? "Verification code sent to your email." : "SMTP isn't configured, so check the server console for your verification code.",
      devCode,
    });
  })
);

router.post(
  "/resend-otp",
  ah(async (req, res) => {
    const { userId } = req.body || {};
    const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.is_verified) return res.status(400).json({ error: "Account is already verified" });

    const { delivered, devCode } = await createAndSendOtp(user.id, user.email);
    res.json({ message: delivered ? "Code resent." : "SMTP isn't configured, so check the server console.", devCode });
  })
);

router.post(
  "/verify-otp",
  ah(async (req, res) => {
    const { userId, code } = req.body || {};
    if (!userId || !code) return res.status(400).json({ error: "userId and code are required" });

    const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.is_verified) return res.status(400).json({ error: "Account is already verified" });

    const { rows: otpRows } = await db.query(
      "SELECT * FROM otp_codes WHERE user_id = $1 AND code = $2 AND consumed = false ORDER BY id DESC LIMIT 1",
      [userId, code]
    );
    const otp = otpRows[0];
    if (!otp) return res.status(400).json({ error: "Incorrect code" });
    if (new Date(otp.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "Code expired, request a new one" });
    }
    await db.query("UPDATE otp_codes SET consumed = true WHERE id = $1", [otp.id]);

    const bonus = await getNumberSetting("signup_bonus_credits");
    await db.query("UPDATE users SET is_verified = true WHERE id = $1", [userId]);
    if (bonus > 0) {
      await adjustBalance(userId, bonus, "signup_bonus", null);
    }

    const { rows: freshRows } = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
    const freshUser = freshRows[0];
    const token = issueToken(freshUser);
    res.json({ token, user: publicUser(freshUser) });
  })
);

router.post(
  "/login",
  ah(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email and password are required" });

    const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];
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
  })
);

router.get("/me", authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = router;
