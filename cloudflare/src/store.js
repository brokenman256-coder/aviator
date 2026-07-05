const DEFAULTS = {
  house_edge_percent: "5",
  signup_bonus_credits: "1000",
  min_bet: "10",
  max_bet: "10000",
  referral_bonus_credits: "500",
  feedback_section_title: "Review & Feedback",
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
//
// The check-and-update is a single atomic SQL statement (not a separate
// read followed by a write), so two concurrent calls for the same user can't
// both read the same starting balance and silently clobber each other —
// SQLite serializes writes to a row, and the WHERE clause re-evaluates
// against whatever the balance actually is at write time.
async function adjustBalance(db, userId, delta, type, meta) {
  const rounded = Math.round(delta * 100) / 100;
  const row = await db
    .prepare(
      `UPDATE users
       SET balance = ROUND(balance + ?, 2)
       WHERE id = ? AND ROUND(balance + ?, 2) >= 0
       RETURNING balance`
    )
    .bind(rounded, userId, rounded)
    .first();

  if (!row) {
    const exists = await db.prepare("SELECT 1 FROM users WHERE id = ?").bind(userId).first();
    if (!exists) throw new Error("User not found");
    throw new Error("Insufficient balance");
  }

  await logWalletTx(db, userId, type, rounded, row.balance, meta);
  return row.balance;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    phone: u.phone || null,
    balance: u.balance,
    isAdmin: !!u.is_admin,
    isBanned: !!u.is_banned,
    isVerified: !!u.is_verified,
    createdAt: u.created_at,
    referralCode: u.referral_code || null,
    referredBy: u.referred_by || null,
  };
}

export { getSetting, getNumberSetting, setSetting, logWalletTx, adjustBalance, publicUser };
