import { Hono } from "hono";
import { authRequired } from "./middleware.js";
import { adjustBalance, getNumberSetting, getSetting, publicUser } from "./store.js";
import {
  createRazorpayOrder,
  isRazorpayConfigured,
  rupeesToPaise,
  verifyPaymentSignature,
  verifyWebhookSignature,
  getRazorpayConfig,
} from "./razorpay.js";

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

async function fulfillPaymentOrder(db, orderId, razorpayPaymentId) {
  const order = await db.prepare("SELECT * FROM payment_orders WHERE id = ?").bind(orderId).first();
  if (!order) throw new Error("Payment order not found");
  if (order.status === "paid") return order;

  const claim = await db.prepare(
    "UPDATE payment_orders SET status = 'paid', razorpay_payment_id = ?, paid_at = ? WHERE id = ? AND status = 'created'"
  ).bind(razorpayPaymentId, new Date().toISOString(), orderId).run();

  if (!claim.meta.changes) {
    return db.prepare("SELECT * FROM payment_orders WHERE id = ?").bind(orderId).first();
  }

  await adjustBalance(db, order.user_id, order.credits_to_add, "razorpay_topup", {
    razorpayOrderId: order.razorpay_order_id,
    razorpayPaymentId,
    amountInr: order.amount_inr,
  });

  return db.prepare("SELECT * FROM payment_orders WHERE id = ?").bind(orderId).first();
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

// ---------- Razorpay online payments ----------

wallet.get("/razorpay/config", authRequired, async (c) => {
  const configured = isRazorpayConfigured(c.env);
  if (!configured) return c.json({ configured: false });
  const creditsPerRupee = await getNumberSetting(c.env.DB, "credits_per_rupee");
  return c.json({
    configured: true,
    keyId: getRazorpayConfig(c.env).keyId,
    creditsPerRupee: isFinite(creditsPerRupee) && creditsPerRupee > 0 ? creditsPerRupee : 1,
  });
});

wallet.post("/razorpay/create-order", authRequired, async (c) => {
  if (!isRazorpayConfigured(c.env)) {
    return c.json({ error: "Online payments are not configured yet" }, 503);
  }

  const user = c.get("user");
  const { amountInr } = await c.req.json().catch(() => ({}));
  const parsed = Math.round(Number(amountInr) * 100) / 100;

  if (!isFinite(parsed) || parsed < 10) {
    return c.json({ error: "Minimum payment is ₹10" }, 400);
  }
  if (parsed > 50000) {
    return c.json({ error: "Maximum payment is ₹50,000" }, 400);
  }

  const creditsPerRupee = await getNumberSetting(c.env.DB, "credits_per_rupee");
  const rate = isFinite(creditsPerRupee) && creditsPerRupee > 0 ? creditsPerRupee : 1;
  const creditsToAdd = Math.round(parsed * rate * 100) / 100;
  const amountPaise = rupeesToPaise(parsed);
  const receipt = `topup_${user.id}_${Date.now()}`;

  const razorpayOrder = await createRazorpayOrder(c.env, amountPaise, receipt, {
    userId: String(user.id),
    purpose: "wallet_topup",
  });

  const now = new Date().toISOString();
  const info = await c.env.DB.prepare(
    `INSERT INTO payment_orders (user_id, razorpay_order_id, amount_inr, amount_paise, credits_to_add, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'created', ?)`
  ).bind(user.id, razorpayOrder.id, parsed, amountPaise, creditsToAdd, now).run();

  return c.json({
    paymentOrderId: info.meta.last_row_id,
    razorpayOrderId: razorpayOrder.id,
    amountInr: parsed,
    amountPaise,
    creditsToAdd,
    keyId: getRazorpayConfig(c.env).keyId,
  });
});

wallet.post("/razorpay/verify", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const razorpayOrderId = String(body.razorpay_order_id || "");
  const razorpayPaymentId = String(body.razorpay_payment_id || "");
  const razorpaySignature = String(body.razorpay_signature || "");

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return c.json({ error: "Missing payment details" }, 400);
  }

  if (!(await verifyPaymentSignature(c.env, razorpayOrderId, razorpayPaymentId, razorpaySignature))) {
    return c.json({ error: "Invalid payment signature" }, 400);
  }

  const order = await c.env.DB.prepare(
    "SELECT * FROM payment_orders WHERE razorpay_order_id = ?"
  ).bind(razorpayOrderId).first();

  if (!order) return c.json({ error: "Payment order not found" }, 404);
  if (order.user_id !== user.id) return c.json({ error: "Forbidden" }, 403);

  const fulfilled = await fulfillPaymentOrder(c.env.DB, order.id, razorpayPaymentId);
  const updatedUser = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();

  return c.json({
    ok: true,
    creditsAdded: fulfilled.credits_to_add,
    balance: updatedUser.balance,
  });
});

wallet.post("/razorpay/webhook", async (c) => {
  const body = await c.req.text();
  const signature = c.req.header("x-razorpay-signature") || "";

  if (!(await verifyWebhookSignature(c.env, body, signature))) {
    return c.json({ error: "Invalid webhook signature" }, 400);
  }

  try {
    const event = JSON.parse(body);
    if (event.event !== "payment.captured") return c.json({ ok: true });

    const payment = event.payload?.payment?.entity;
    if (!payment?.order_id || !payment?.id) return c.json({ ok: true });

    const order = await c.env.DB.prepare(
      "SELECT * FROM payment_orders WHERE razorpay_order_id = ?"
    ).bind(payment.order_id).first();

    if (!order || order.status === "paid") return c.json({ ok: true });

    await fulfillPaymentOrder(c.env.DB, order.id, payment.id);
    return c.json({ ok: true });
  } catch (err) {
    console.error(err);
    return c.json({ error: "Webhook processing failed" }, 500);
  }
});

export default wallet;
