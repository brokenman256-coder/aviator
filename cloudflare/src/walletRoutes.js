import { Hono } from "hono";
import { authRequired } from "./middleware.js";
import { adjustBalance, getNumberSetting, getSetting, publicUser } from "./store.js";
import { validateScreenshot } from "./paymentProof.js";

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
  return new Date().toISOString().slice(0, 10);
}

function dayKeyOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

wallet.get("/daily-wheel", authRequired, async (c) => {
  const user = c.get("user");
  const { prizes } = await loadWheel(c.env.DB);
  const claim = await c.env.DB.prepare(
    "SELECT amount FROM daily_bonus_claims WHERE user_id = ? AND claim_date = ?"
  ).bind(user.id, todayKey()).first();
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

  const insert = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO daily_bonus_claims (user_id, claim_date, amount, created_at) VALUES (?, ?, ?, ?)"
  ).bind(user.id, date, amount, now).run();

  if (!insert.meta.changes) {
    return c.json({ error: "You've already spun the wheel today — come back tomorrow." }, 400);
  }

  const streak = user.last_spin_date === dayKeyOffset(-1) ? (user.daily_streak || 0) + 1 : 1;
  await c.env.DB.prepare(
    "UPDATE users SET daily_streak = ?, last_spin_date = ? WHERE id = ?"
  ).bind(streak, date, user.id).run();

  await adjustBalance(c.env.DB, user.id, amount, "daily_wheel", { date });
  const perDay = await getNumberSetting(c.env.DB, "streak_bonus_per_day");
  const streakBonus = Math.min(streak, 7) * (isFinite(perDay) ? perDay : 10);
  let balance = await adjustBalance(c.env.DB, user.id, streakBonus, "streak_bonus", { date, streak });

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

wallet.get("/payment-info", authRequired, async (c) => {
  const creditsPerRupee = await getNumberSetting(c.env.DB, "credits_per_rupee");
  return c.json({
    upiId: await getSetting(c.env.DB, "payment_upi_id"),
    instructions: await getSetting(c.env.DB, "payment_instructions"),
    creditsPerRupee: isFinite(creditsPerRupee) && creditsPerRupee > 0 ? creditsPerRupee : 1,
    minAmountInr: 10,
  });
});

wallet.get("/recharge-requests", authRequired, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, user_id, amount, amount_inr, payment_reference, type, status, admin_note,
            resolved_by, resolved_at, created_at, screenshot_mime,
            CASE WHEN screenshot_data IS NOT NULL THEN 1 ELSE 0 END AS has_screenshot
     FROM recharge_requests WHERE user_id = ? ORDER BY id DESC LIMIT 30`
  )
    .bind(c.get("user").id)
    .all();
  return c.json({
    requests: results.map((r) => ({
      ...r,
      hasScreenshot: !!r.has_screenshot,
      has_screenshot: undefined,
    })),
  });
});

wallet.get("/recharge-requests/:id/screenshot", authRequired, async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(
    "SELECT user_id, screenshot_mime, screenshot_data FROM recharge_requests WHERE id = ?"
  ).bind(id).first();
  if (!row || row.user_id !== c.get("user").id) return c.json({ error: "Not found" }, 404);
  if (!row.screenshot_data) return c.json({ error: "No screenshot" }, 404);
  return c.json({ mimeType: row.screenshot_mime, data: row.screenshot_data });
});

wallet.post("/recharge-request", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const requestType = body.type === "withdrawal" ? "withdrawal" : "recharge";

  const pending = await c.env.DB.prepare(
    "SELECT id FROM recharge_requests WHERE user_id = ? AND status = 'pending'"
  ).bind(user.id).first();
  if (pending) return c.json({ error: "You already have a pending request" }, 400);

  const now = new Date().toISOString();

  if (requestType === "withdrawal") {
    const parsed = Math.round(Number(body.amount) * 100) / 100;
    if (!isFinite(parsed) || parsed <= 0 || parsed > 1000000) {
      return c.json({ error: "Enter a valid amount" }, 400);
    }
    if (parsed > user.balance) {
      return c.json({ error: "You can't request a withdrawal larger than your current balance" }, 400);
    }
    const info = await c.env.DB.prepare(
      "INSERT INTO recharge_requests (user_id, amount, type, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
    ).bind(user.id, parsed, requestType, now).run();
    return c.json({ id: info.meta.last_row_id, status: "pending", type: requestType });
  }

  const amountInr = Math.round(Number(body.amountInr) * 100) / 100;
  if (!isFinite(amountInr) || amountInr < 10 || amountInr > 50000) {
    return c.json({ error: "Enter a valid payment amount (₹10 – ₹50,000)" }, 400);
  }

  const proof = validateScreenshot(body.screenshotMime, body.screenshot);
  if (!proof.ok) return c.json({ error: proof.error }, 400);

  const creditsPerRupee = await getNumberSetting(c.env.DB, "credits_per_rupee");
  const rate = isFinite(creditsPerRupee) && creditsPerRupee > 0 ? creditsPerRupee : 1;
  const credits = Math.round(amountInr * rate * 100) / 100;
  const paymentRef = String(body.paymentReference || "").trim().slice(0, 64) || null;

  const info = await c.env.DB.prepare(
    `INSERT INTO recharge_requests
      (user_id, amount, amount_inr, payment_reference, screenshot_mime, screenshot_data, type, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'recharge', 'pending', ?)`
  ).bind(user.id, credits, amountInr, paymentRef, body.screenshotMime, proof.data, now).run();

  return c.json({
    id: info.meta.last_row_id,
    status: "pending",
    type: "recharge",
    amountInr,
    credits,
  });
});

export default wallet;
