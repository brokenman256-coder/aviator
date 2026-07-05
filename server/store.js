const db = require("./db");
const config = require("./config");

const DEFAULTS = {
  house_edge_percent: String(config.DEFAULT_HOUSE_EDGE_PERCENT),
  signup_bonus_credits: String(config.SIGNUP_BONUS_CREDITS),
  min_bet: "10",
  max_bet: "10000",
};

function ensureDefaults() {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    const row = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key);
    if (!row) setSetting(key, value);
  }
}

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : DEFAULTS[key];
}

function getNumberSetting(key) {
  return Number(getSetting(key));
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function logWalletTx(userId, type, amount, balanceAfter, meta) {
  db.prepare(
    `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, type, amount, balanceAfter, meta ? JSON.stringify(meta) : null, new Date().toISOString());
}

// Applies a signed credit delta to a user's balance and records the ledger entry.
// Throws if the user doesn't exist or the adjustment would take them negative.
function adjustBalance(userId, delta, type, meta) {
  const user = db.prepare("SELECT balance FROM users WHERE id = ?").get(userId);
  if (!user) throw new Error("User not found");
  const newBalance = Math.round((user.balance + delta) * 100) / 100;
  if (newBalance < 0) throw new Error("Insufficient balance");
  db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBalance, userId);
  logWalletTx(userId, type, delta, newBalance, meta);
  return newBalance;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    balance: u.balance,
    isAdmin: !!u.is_admin,
    isBanned: !!u.is_banned,
    isVerified: !!u.is_verified,
    createdAt: u.created_at,
  };
}

module.exports = {
  ensureDefaults,
  getSetting,
  getNumberSetting,
  setSetting,
  logWalletTx,
  adjustBalance,
  publicUser,
};
