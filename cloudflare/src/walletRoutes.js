import { Hono } from "hono";
import { authRequired } from "./middleware.js";
import { adjustBalance, getNumberSetting, getSetting, publicUser } from "./store.js";

const wallet = new Hono();

const DEFAULT_PRIZES = [100, 50, 20, 30, 40, 500];
const DEFAULT_WEIGHTS = [14, 24, 70, 50, 40, 2];

function parseCsvNums(str, fallback) {
  const nums = String(str || "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => isFinite(n) && n >= 0);
  return nums.length ? nums : fallback.slice();
}

// The wheel prizes and their odds are admin-configurable (settings). The wheel
// shows equal slices, but weights let the admin keep big prizes rare so the
// average payout stays low and the house stays in profit.
async function loadWheel(db) {
  const prizes = parseCsvNums(await getSetting(db, "wheel_prizes"), DEFAULT_PRIZES);
  let weights = parseCsvNums(await getSetting(db, "wheel_weights"), DEFAULT_WEIGHTS);
  if (weights.length !== prizes.length) weights = prizes.map(() => 1);
  return { prizes, weights };
}

function pickWeightedIndex(weights) {
  const total = weights.reduce((a, b) => a + b, 0) || weights.length;
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    if ((r -= weights[i]) < 0) return i;
  }
  return weights.length - 1;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC calendar day
}

function dayKeyOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Whether the player has already spun today, plus the wheel layout and streak.
wallet.get("/daily-wheel", authRequired, async (c) => {
  const user = c.get("user");
  const { prizes } = await loadWheel(c.env.DB);
  const claim = await c.env.DB.prepare(
    "SELECT amount FROM daily_bonus_claims WHERE user_id = ? AND claim_date = ?"
  ).bind(user.id, todayKey()).first();
  // A streak only still counts if the last spin was today or yesterday.
  const stillValid = user.last_spin_date === todayKey() || user.last_spin_date === dayKeyOffset(-1);
  return c.json({
    prizes,
    claimedToday: !!claim,
    claimedAmount: claim ? claim.amount : null,
    streak: stillValid ? user.daily_streak : 0,
  });
});

wallet.post("/daily-wheel/spin", authRequired, async (c) => {
  const user = c.get("user");
  const date = todayKey();
  const { prizes, weights } = await loadWheel(c.env.DB);
  const index = pickWeightedIndex(weights);
  const amount = prizes[index];
  const now = new Date().toISOString();

  // The unique (user_id, claim_date) index makes this the atomic gate: only the
  // first spin of the day inserts a row; a second one changes nothing.
  const insert = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO daily_bonus_claims (user_id, claim_date, amount, created_at) VALUES (?, ?, ?, ?)"
  ).bind(user.id, date, amount, now).run();

  if (!insert.meta.changes) {
    return c.json({ error: "You've already spun the wheel today — come back tomorrow." }, 400);
  }

  // Streak: incrementing if the previous spin was yesterday, otherwise reset to 1.
  const streak = user.last_spin_date === dayKeyOffset(-1) ? (user.daily_streak || 0) + 1 : 1;
  await c.env.DB.prepare(
    "UPDATE users SET daily_streak = ?, last_spin_date = ? WHERE id = ?"
  ).bind(streak, date, user.id).run();

  await adjustBalance(c.env.DB, user.id, amount, "daily_wheel", { date });
  const perDay = await getNumberSetting(c.env.DB, "streak_bonus_per_day");
  const streakBonus = Math.min(streak, 7) * (isFinite(perDay) ? perDay : 10);
  let balance = await adjustBalance(c.env.DB, user.id, streakBonus, "streak_bonus", { date, streak });

  // First-spin referral payout: paying on first activity (not on signup) keeps
  // throwaway accounts from farming the bonus. Guarded on referral_rewarded so
  // it can only ever pay once per invited player.
  let referralPaid = 0;
  if (user.referred_by && !user.referral_rewarded) {
    const claimed = await c.env.DB.prepare(
      "UPDATE users SET referral_rewarded = 1 WHERE id = ? AND referral_rewarded = 0"
    ).bind(user.id).run();
    if (claimed.meta.changes) {
      referralPaid = await getNumberSetting(c.env.DB, "referral_bonus_credits");
      if (referralPaid > 0) {
        balance = await adjustBalance(c.env.DB, user.id, referralPaid, "referral_bonus", { referredBy: user.referred_by });
        await adjustBalance(c.env.DB, user.referred_by, referralPaid, "referral_bonus", { referredUser: user.id });
      }
    }
  }

  return c.json({ index, amount, streak, streakBonus, referralBonus: referralPaid, balance });
});

wallet.get("/me", authRequired, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 30"
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ user: publicUser(c.get("user")), transactions: results });
});

// Invite page data: your code, who you invited (subordinate data), and how
// many credits you've earned from referrals.
wallet.get("/referral", authRequired, async (c) => {
  const user = c.get("user");
  const { results: invited } = await c.env.DB.prepare(
    `SELECT id, username, created_at, referral_rewarded FROM users WHERE referred_by = ? ORDER BY id DESC`
  ).bind(user.id).all();
  const earned = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions WHERE user_id = ? AND type = 'referral_bonus'`
  ).bind(user.id).first();
  const bonus = await getNumberSetting(c.env.DB, "referral_bonus_credits");
  return c.json({
    code: user.referral_code,
    bonusPerReferral: bonus,
    invited: invited.map((u) => ({
      username: u.username,
      joinedAt: u.created_at,
      active: !!u.referral_rewarded,
    })),
    totalEarned: earned.total,
  });
});

wallet.get("/recharge-requests", authRequired, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM recharge_requests WHERE user_id = ? ORDER BY id DESC LIMIT 30"
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ requests: results });
});

wallet.post("/recharge-request", authRequired, async (c) => {
  const user = c.get("user");
  const { amount, type } = await c.req.json().catch(() => ({}));
  const requestType = type === "withdrawal" ? "withdrawal" : "recharge";
  const parsed = Math.round(Number(amount) * 100) / 100;
  if (!isFinite(parsed) || parsed <= 0 || parsed > 1000000) {
    return c.json({ error: "Enter a valid amount" }, 400);
  }
  if (requestType === "withdrawal" && parsed > user.balance) {
    return c.json({ error: "You can't request a withdrawal larger than your current balance" }, 400);
  }

  const pending = await c.env.DB.prepare(
    "SELECT id FROM recharge_requests WHERE user_id = ? AND status = 'pending'"
  ).bind(user.id).first();
  if (pending) return c.json({ error: "You already have a pending request" }, 400);

  const now = new Date().toISOString();
  const info = await c.env.DB.prepare(
    "INSERT INTO recharge_requests (user_id, amount, type, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
  ).bind(user.id, parsed, requestType, now).run();

  return c.json({ id: info.meta.last_row_id, status: "pending", type: requestType });
});

export default wallet;
