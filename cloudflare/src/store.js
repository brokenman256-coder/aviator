const DEFAULTS = {
  house_edge_percent: "5",
  signup_bonus_credits: "1000",
  min_bet: "10",
  max_bet: "10000",
};

async function getSetting(db, key) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : DEFAULTS[key];
}

async function getNumberSetting(db, key) {
  return Number(await getSetting(db, key));
}

async function setSetting(db, key, value) {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(key, String(value))
    .run();
}

async function logWalletTx(db, userId, type, amount, balanceAfter, meta) {
  await db
    .prepare(
      `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, type, amount, balanceAfter, meta ? JSON.stringify(meta) : null, new Date().toISOString())
    .run();
}

// Applies a signed credit delta to a user's balance and records the ledger entry.
// Throws if the user doesn't exist or the adjustment would take them negative.
async function adjustBalance(db, userId, delta, type, meta) {
  const user = await db.prepare("SELECT balance FROM users WHERE id = ?").bind(userId).first();
  if (!user) throw new Error("User not found");
  const newBalance = Math.round((user.balance + delta) * 100) / 100;
  if (newBalance < 0) throw new Error("Insufficient balance");
  await db.prepare("UPDATE users SET balance = ? WHERE id = ?").bind(newBalance, userId).run();
  await logWalletTx(db, userId, type, delta, newBalance, meta);
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

export { getSetting, getNumberSetting, setSetting, logWalletTx, adjustBalance, publicUser };
