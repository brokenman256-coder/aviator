const db = require("./db");
const config = require("./config");

const DEFAULTS = {
  house_edge_percent: String(config.DEFAULT_HOUSE_EDGE_PERCENT),
  signup_bonus_credits: String(config.SIGNUP_BONUS_CREDITS),
  min_bet: "10",
  max_bet: "10000",
  trade_min_stake: "10",
  trade_max_stake: "5000",
};

async function ensureDefaults() {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    const { rows } = await db.query("SELECT 1 FROM settings WHERE key = $1", [key]);
    if (!rows.length) await setSetting(key, value);
  }
}

async function getSetting(key) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = $1", [key]);
  return rows.length ? rows[0].value : DEFAULTS[key];
}

async function getNumberSetting(key) {
  return Number(await getSetting(key));
}

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

// Applies a signed credit delta to a user's balance and records the ledger
// entry, atomically (row-locked) so concurrent requests for the same user
// can't race each other into an inconsistent balance.
async function adjustBalance(userId, delta, type, meta) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query("SELECT balance FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!rows.length) throw new Error("User not found");
    const newBalance = Math.round((rows[0].balance + delta) * 100) / 100;
    if (newBalance < 0) throw new Error("Insufficient balance");
    await client.query("UPDATE users SET balance = $1 WHERE id = $2", [newBalance, userId]);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, meta, created_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [userId, type, delta, newBalance, meta ? JSON.stringify(meta) : null]
    );
    return newBalance;
  });
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
  adjustBalance,
  publicUser,
};
