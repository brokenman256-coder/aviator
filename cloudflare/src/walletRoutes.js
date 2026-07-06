import { Hono } from "hono";
import { authRequired } from "./middleware.js";
import { adjustBalance, publicUser } from "./store.js";

const wallet = new Hono();

// Prizes on the daily spin wheel, in wheel-segment order.
const WHEEL_PRIZES = [100, 50, 20, 30, 40, 500];

function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC calendar day
}

function dayKeyOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Streak bonus grows with the run of consecutive days, capped so it stays modest.
function streakBonusFor(streak) {
  return Math.min(streak, 7) * 10;
}

// Whether the player has already spun today, plus the wheel layout and streak.
wallet.get("/daily-wheel", authRequired, async (c) => {
  const user = c.get("user");
  const claim = await c.env.DB.prepare(
    "SELECT amount FROM daily_bonus_claims WHERE user_id = ? AND claim_date = ?"
  ).bind(user.id, todayKey()).first();
  // A streak only still counts if the last spin was today or yesterday.
  const stillValid = user.last_spin_date === todayKey() || user.last_spin_date === dayKeyOffset(-1);
  return c.json({
    prizes: WHEEL_PRIZES,
    claimedToday: !!claim,
    claimedAmount: claim ? claim.amount : null,
    streak: stillValid ? user.daily_streak : 0,
  });
});

wallet.post("/daily-wheel/spin", authRequired, async (c) => {
  const user = c.get("user");
  const date = todayKey();
  const index = Math.floor(Math.random() * WHEEL_PRIZES.length);
  const amount = WHEEL_PRIZES[index];
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
  const streakBonus = streakBonusFor(streak);
  const balance = await adjustBalance(c.env.DB, user.id, streakBonus, "streak_bonus", { date, streak });

  return c.json({ index, amount, streak, streakBonus, balance });
});

wallet.get("/me", authRequired, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 30"
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ user: publicUser(c.get("user")), transactions: results });
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
