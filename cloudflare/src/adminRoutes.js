import { Hono } from "hono";
import { authRequired, adminRequired } from "./middleware.js";
import { adjustBalance, getSetting, setSetting, publicUser } from "./store.js";

const admin = new Hono();
admin.use("*", authRequired, adminRequired);

admin.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM users ORDER BY id DESC").all();
  return c.json({ users: results.map(publicUser) });
});

admin.post("/users/:id/adjust", async (c) => {
  const userId = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const delta = Number(body.amount);
  const reason = (body.reason || "").trim();
  if (!isFinite(delta) || delta === 0) {
    return c.json({ error: "amount must be a non-zero number" }, 400);
  }
  if (!reason) {
    return c.json({ error: "A reason is required for balance adjustments" }, 400);
  }
  try {
    const balance = await adjustBalance(c.env.DB, userId, delta, "admin_adjust", { reason, adminId: c.get("user").id });
    return c.json({ balance });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

admin.post("/users/:id/ban", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const banned = body.banned ? 1 : 0;
  await c.env.DB.prepare("UPDATE users SET is_banned = ? WHERE id = ?").bind(banned, c.req.param("id")).run();
  return c.json({ ok: true });
});

admin.post("/users/:id/admin", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const isAdmin = body.isAdmin ? 1 : 0;
  await c.env.DB.prepare("UPDATE users SET is_admin = ? WHERE id = ?").bind(isAdmin, c.req.param("id")).run();
  return c.json({ ok: true });
});

admin.get("/settings", async (c) => {
  return c.json({
    houseEdgePercent: Number(await getSetting(c.env.DB, "house_edge_percent")),
    signupBonusCredits: Number(await getSetting(c.env.DB, "signup_bonus_credits")),
    minBet: Number(await getSetting(c.env.DB, "min_bet")),
    maxBet: Number(await getSetting(c.env.DB, "max_bet")),
    referralBonusCredits: Number(await getSetting(c.env.DB, "referral_bonus_credits")),
    streakBonusPerDay: Number(await getSetting(c.env.DB, "streak_bonus_per_day")),
    creditsPerRupee: Number(await getSetting(c.env.DB, "credits_per_rupee")),
    paymentUpiId: await getSetting(c.env.DB, "payment_upi_id"),
    paymentInstructions: await getSetting(c.env.DB, "payment_instructions"),
    wheelPrizes: await getSetting(c.env.DB, "wheel_prizes"),
    wheelWeights: await getSetting(c.env.DB, "wheel_weights"),
    siteName: await getSetting(c.env.DB, "site_name"),
  });
});

function sanitizeCsvNums(str) {
  return String(str || "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => isFinite(n) && n >= 0)
    .join(",");
}

admin.post("/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const {
    houseEdgePercent,
    signupBonusCredits,
    minBet,
    maxBet,
    referralBonusCredits,
    streakBonusPerDay,
    creditsPerRupee,
    paymentUpiId,
    paymentInstructions,
    wheelPrizes,
    wheelWeights,
    siteName,
  } = body;
  if (siteName !== undefined) {
    const clean = String(siteName).trim().slice(0, 24);
    if (clean) await setSetting(c.env.DB, "site_name", clean);
  }
  if (houseEdgePercent !== undefined) {
    await setSetting(c.env.DB, "house_edge_percent", Math.min(50, Math.max(0, Number(houseEdgePercent))));
  }
  if (signupBonusCredits !== undefined) {
    await setSetting(c.env.DB, "signup_bonus_credits", Math.max(0, Number(signupBonusCredits)));
  }
  if (minBet !== undefined) await setSetting(c.env.DB, "min_bet", Math.max(1, Number(minBet)));
  if (maxBet !== undefined) await setSetting(c.env.DB, "max_bet", Math.max(1, Number(maxBet)));
  if (referralBonusCredits !== undefined) {
    await setSetting(c.env.DB, "referral_bonus_credits", Math.max(0, Number(referralBonusCredits)));
  }
  if (streakBonusPerDay !== undefined) {
    await setSetting(c.env.DB, "streak_bonus_per_day", Math.max(0, Number(streakBonusPerDay)));
  }
  if (creditsPerRupee !== undefined) {
    await setSetting(c.env.DB, "credits_per_rupee", Math.max(0.01, Number(creditsPerRupee)));
  }
  if (paymentUpiId !== undefined) {
    await setSetting(c.env.DB, "payment_upi_id", String(paymentUpiId).trim().slice(0, 64));
  }
  if (paymentInstructions !== undefined) {
    await setSetting(c.env.DB, "payment_instructions", String(paymentInstructions).trim().slice(0, 500));
  }
  if (wheelPrizes !== undefined) {
    const clean = sanitizeCsvNums(wheelPrizes);
    if (clean) await setSetting(c.env.DB, "wheel_prizes", clean);
  }
  if (wheelWeights !== undefined) {
    const clean = sanitizeCsvNums(wheelWeights);
    if (clean) await setSetting(c.env.DB, "wheel_weights", clean);
  }
  return c.json({ ok: true });
});

admin.get("/stats", async (c) => {
  const totals = await c.env.DB.prepare(
    `SELECT
      COALESCE(SUM(CASE WHEN type = 'bet' THEN -amount ELSE 0 END), 0) AS wagered,
      COALESCE(SUM(CASE WHEN type = 'payout' THEN amount ELSE 0 END), 0) AS paidOut,
      COALESCE(SUM(CASE WHEN type = 'signup_bonus' THEN amount ELSE 0 END), 0) AS bonusesGiven,
      COALESCE(SUM(CASE WHEN type = 'admin_adjust' THEN amount ELSE 0 END), 0) AS adminAdjustments
    FROM wallet_transactions`
  ).first();

  const userCount = (await c.env.DB.prepare("SELECT COUNT(*) AS c FROM users").first()).c;
  const roundCount = (await c.env.DB.prepare("SELECT COUNT(*) AS c FROM rounds WHERE ended_at IS NOT NULL").first()).c;

  const rewards = await c.env.DB.prepare(
    `SELECT
      COALESCE(SUM(CASE WHEN type = 'daily_wheel' THEN amount ELSE 0 END), 0) AS wheelPaid,
      COALESCE(SUM(CASE WHEN type = 'streak_bonus' THEN amount ELSE 0 END), 0) AS streakPaid,
      COALESCE(SUM(CASE WHEN type = 'referral_bonus' THEN amount ELSE 0 END), 0) AS referralPaid
    FROM wallet_transactions`
  ).first();
  const spinsToday = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS c FROM daily_bonus_claims WHERE claim_date = ?"
  ).bind(new Date().toISOString().slice(0, 10)).first()).c;

  return c.json({
    ...totals,
    houseProfit: Math.round((totals.wagered - totals.paidOut) * 100) / 100,
    userCount,
    roundCount,
    rewards: {
      wheelPaid: Math.round(rewards.wheelPaid * 100) / 100,
      streakPaid: Math.round(rewards.streakPaid * 100) / 100,
      referralPaid: Math.round(rewards.referralPaid * 100) / 100,
      spinsToday,
    },
  });
});

admin.get("/rounds", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM rounds ORDER BY id DESC LIMIT 50").all();
  return c.json({ rounds: results });
});

admin.get("/users/:id", async (c) => {
  const userId = Number(c.req.param("id"));
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) return c.json({ error: "User not found" }, 404);

  const { results: bets } = await c.env.DB.prepare(
    "SELECT * FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT 50"
  ).bind(userId).all();
  const { results: transactions } = await c.env.DB.prepare(
    "SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50"
  ).bind(userId).all();

  return c.json({ user: publicUser(user), bets, transactions });
});

admin.post("/users/:id/delete", async (c) => {
  const userId = Number(c.req.param("id"));
  if (userId === c.get("user").id) return c.json({ error: "You can't delete your own account" }, 400);

  await c.env.DB.prepare("DELETE FROM wallet_transactions WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM bets WHERE user_id = ?").bind(userId).run();
  const info = await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();

  if (!info.meta.changes) return c.json({ error: "User not found" }, 404);
  return c.json({ ok: true });
});

admin.get("/live-round", async (c) => {
  const id = c.env.GAME_ROOM.idFromName("global");
  const stub = c.env.GAME_ROOM.get(id);
  const res = await stub.fetch("https://game-room/admin/state");
  return c.json(await res.json());
});

admin.post("/round/force-crash", async (c) => {
  const id = c.env.GAME_ROOM.idFromName("global");
  const stub = c.env.GAME_ROOM.get(id);
  const res = await stub.fetch("https://game-room/admin/force-crash", { method: "POST" });
  return c.json(await res.json());
});

admin.get("/recharge-requests", async (c) => {
  const status = c.req.query("status");
  const query = status
    ? c.env.DB.prepare(
        `SELECT rr.id, rr.user_id, rr.amount, rr.amount_inr, rr.payment_reference, rr.type, rr.status,
                rr.admin_note, rr.resolved_by, rr.resolved_at, rr.created_at, rr.screenshot_mime,
                CASE WHEN rr.screenshot_data IS NOT NULL THEN 1 ELSE 0 END AS has_screenshot,
                u.username
         FROM recharge_requests rr JOIN users u ON u.id = rr.user_id
         WHERE rr.status = ? ORDER BY rr.id DESC LIMIT 100`
      ).bind(status)
    : c.env.DB.prepare(
        `SELECT rr.id, rr.user_id, rr.amount, rr.amount_inr, rr.payment_reference, rr.type, rr.status,
                rr.admin_note, rr.resolved_by, rr.resolved_at, rr.created_at, rr.screenshot_mime,
                CASE WHEN rr.screenshot_data IS NOT NULL THEN 1 ELSE 0 END AS has_screenshot,
                u.username
         FROM recharge_requests rr JOIN users u ON u.id = rr.user_id
         ORDER BY rr.id DESC LIMIT 100`
      );
  const { results } = await query.all();
  return c.json({
    requests: results.map((r) => ({
      ...r,
      hasScreenshot: !!r.has_screenshot,
      has_screenshot: undefined,
    })),
  });
});

admin.get("/recharge-requests/:id/screenshot", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(
    "SELECT screenshot_mime, screenshot_data, amount_inr, payment_reference, type FROM recharge_requests WHERE id = ?"
  ).bind(id).first();
  if (!row?.screenshot_data) return c.json({ error: "No screenshot" }, 404);
  return c.json({
    mimeType: row.screenshot_mime,
    data: row.screenshot_data,
    amountInr: row.amount_inr,
    paymentReference: row.payment_reference,
    type: row.type,
  });
});

admin.post("/recharge-requests/:id/approve", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const request = await c.env.DB.prepare("SELECT * FROM recharge_requests WHERE id = ?").bind(id).first();
  if (!request) return c.json({ error: "Request not found" }, 404);
  if (request.status !== "pending") return c.json({ error: `Request is already ${request.status}` }, 400);

  const claim = await c.env.DB.prepare(
    "UPDATE recharge_requests SET status = 'approved', admin_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'"
  ).bind(body.note || null, c.get("user").id, new Date().toISOString(), id).run();
  if (!claim.meta.changes) return c.json({ error: "Request was already resolved" }, 400);

  const isWithdrawal = request.type === "withdrawal";
  const delta = isWithdrawal ? -request.amount : request.amount;
  const txType = isWithdrawal ? "withdrawal_approved" : "recharge_approved";

  try {
    const balance = await adjustBalance(c.env.DB, request.user_id, delta, txType, { requestId: id, note: body.note || null });
    return c.json({ ok: true, balance });
  } catch (err) {
    await c.env.DB.prepare(
      "UPDATE recharge_requests SET status = 'pending', admin_note = NULL, resolved_by = NULL, resolved_at = NULL WHERE id = ?"
    ).bind(id).run();
    return c.json({ error: err.message }, 400);
  }
});

admin.post("/recharge-requests/:id/reject", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const claim = await c.env.DB.prepare(
    "UPDATE recharge_requests SET status = 'rejected', admin_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'"
  ).bind(body.note || null, c.get("user").id, new Date().toISOString(), id).run();
  if (!claim.meta.changes) return c.json({ error: "Request not found or already resolved" }, 400);
  return c.json({ ok: true });
});

// ---------- Zenith Markets trade module ----------

async function reloadTradeRoom(env) {
  const id = env.TRADE_ROOM.idFromName("global");
  const stub = env.TRADE_ROOM.get(id);
  await stub.fetch("https://trade-room/admin/reload-assets", { method: "POST" });
}

admin.get("/trade/assets", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM trade_assets ORDER BY id").all();
  return c.json({
    assets: results.map((a) => ({
      id: a.id,
      symbol: a.symbol,
      name: a.name,
      price: a.price,
      volatility: a.volatility,
      payoutPercent: a.payout_percent,
      enabled: !!a.enabled,
    })),
  });
});

admin.post("/trade/assets", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { symbol, name, price, volatility, payoutPercent } = body;
  if (!symbol || !name || !isFinite(Number(price))) {
    return c.json({ error: "symbol, name, and a numeric price are required" }, 400);
  }
  try {
    await c.env.DB.prepare(
      `INSERT INTO trade_assets (symbol, name, price, volatility, payout_percent, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`
    )
      .bind(String(symbol).toUpperCase(), name, Number(price), Number(volatility) || 0.001, Number(payoutPercent) || 80)
      .run();
    await reloadTradeRoom(c.env);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

admin.post("/trade/assets/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const existing = await c.env.DB.prepare("SELECT * FROM trade_assets WHERE id = ?").bind(id).first();
  if (!existing) return c.json({ error: "Asset not found" }, 404);

  await c.env.DB.prepare(
    `UPDATE trade_assets SET name = ?, volatility = ?, payout_percent = ?, enabled = ? WHERE id = ?`
  )
    .bind(
      body.name !== undefined ? body.name : existing.name,
      body.volatility !== undefined ? Number(body.volatility) : existing.volatility,
      body.payoutPercent !== undefined ? Number(body.payoutPercent) : existing.payout_percent,
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
      id
    )
    .run();
  await reloadTradeRoom(c.env);
  return c.json({ ok: true });
});

admin.get("/trade/settings", async (c) => {
  return c.json({
    minStake: Number(await getSetting(c.env.DB, "trade_min_stake")),
    maxStake: Number(await getSetting(c.env.DB, "trade_max_stake")),
  });
});

admin.post("/trade/settings", async (c) => {
  const { minStake, maxStake } = await c.req.json().catch(() => ({}));
  if (minStake !== undefined) await setSetting(c.env.DB, "trade_min_stake", Math.max(1, Number(minStake)));
  if (maxStake !== undefined) await setSetting(c.env.DB, "trade_max_stake", Math.max(1, Number(maxStake)));
  return c.json({ ok: true });
});

admin.get("/trade/contracts", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, a.symbol, u.username FROM trade_contracts c
     JOIN trade_assets a ON a.id = c.asset_id
     JOIN users u ON u.id = c.user_id
     ORDER BY c.id DESC LIMIT 50`
  ).all();
  return c.json({ contracts: results });
});

admin.get("/trade/stats", async (c) => {
  const totals = await c.env.DB.prepare(
    `SELECT
      COALESCE(SUM(stake), 0) AS staked,
      COALESCE(SUM(CASE WHEN status = 'won' THEN payout ELSE 0 END), 0) AS paidOut,
      COALESCE(SUM(CASE WHEN status IN ('won', 'lost') THEN 1 ELSE 0 END), 0) AS settledCount
    FROM trade_contracts`
  ).first();
  return c.json({ ...totals, houseProfit: Math.round((totals.staked - totals.paidOut) * 100) / 100 });
});

export default admin;
