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
  const reason = body.reason || null;
  if (!isFinite(delta) || delta === 0) {
    return c.json({ error: "amount must be a non-zero number" }, 400);
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
    referralBonusCredits: Number(await getSetting(c.env.DB, "referral_bonus_credits")),
    minBet: Number(await getSetting(c.env.DB, "min_bet")),
    maxBet: Number(await getSetting(c.env.DB, "max_bet")),
  });
});

admin.post("/settings", async (c) => {
  const { houseEdgePercent, signupBonusCredits, referralBonusCredits, minBet, maxBet } = await c.req.json().catch(() => ({}));
  if (houseEdgePercent !== undefined) {
    await setSetting(c.env.DB, "house_edge_percent", Math.min(50, Math.max(0, Number(houseEdgePercent))));
  }
  if (signupBonusCredits !== undefined) {
    await setSetting(c.env.DB, "signup_bonus_credits", Math.max(0, Number(signupBonusCredits)));
  }
  if (referralBonusCredits !== undefined) {
    await setSetting(c.env.DB, "referral_bonus_credits", Math.max(0, Number(referralBonusCredits)));
  }
  if (minBet !== undefined) await setSetting(c.env.DB, "min_bet", Math.max(1, Number(minBet)));
  if (maxBet !== undefined) await setSetting(c.env.DB, "max_bet", Math.max(1, Number(maxBet)));
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

  return c.json({
    ...totals,
    houseProfit: Math.round((totals.wagered - totals.paidOut) * 100) / 100,
    userCount,
    roundCount,
  });
});

admin.get("/rounds", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM rounds ORDER BY id DESC LIMIT 50").all();
  return c.json({ rounds: results });
});

// Per-user drill-down: full profile plus their recent bets and wallet activity.
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
  const referredUsers = await c.env.DB.prepare(
    "SELECT id, username FROM users WHERE referred_by = ?"
  ).bind(userId).all();

  return c.json({ user: publicUser(user), bets, transactions, referredUsers: referredUsers.results });
});

// Deletes a user account entirely, including their bets and wallet ledger.
admin.post("/users/:id/delete", async (c) => {
  const userId = Number(c.req.param("id"));
  if (userId === c.get("user").id) return c.json({ error: "You can't delete your own account" }, 400);

  await c.env.DB.prepare("DELETE FROM wallet_transactions WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM bets WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("UPDATE users SET referred_by = NULL WHERE referred_by = ?").bind(userId).run();
  const info = await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();

  if (!info.meta.changes) return c.json({ error: "User not found" }, 404);
  return c.json({ ok: true });
});

// Global, timestamped activity feed across every user (vs. the aggregate /stats numbers).
admin.get("/transactions", async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 100));
  const { results } = await c.env.DB.prepare(
    `SELECT wt.*, u.username
     FROM wallet_transactions wt
     JOIN users u ON u.id = wt.user_id
     ORDER BY wt.id DESC
     LIMIT ?`
  ).bind(limit).all();
  return c.json({ transactions: results });
});

// Live view into the current round, including the crash point before it happens.
// Admin-only: regular players never see this over the WebSocket feed.
admin.get("/live-round", async (c) => {
  const id = c.env.GAME_ROOM.idFromName("global");
  const stub = c.env.GAME_ROOM.get(id);
  const res = await stub.fetch("https://game-room/admin/state");
  return c.json(await res.json());
});

// Immediately ends the current round (marks it crashed right now), e.g. to
// recover from a stuck state. Use sparingly — it's a manual override, not
// part of normal gameplay.
admin.post("/round/force-crash", async (c) => {
  const id = c.env.GAME_ROOM.idFromName("global");
  const stub = c.env.GAME_ROOM.get(id);
  const res = await stub.fetch("https://game-room/admin/force-crash", { method: "POST" });
  return c.json(await res.json());
});

// ---------- Recharge requests ----------

admin.get("/recharge-requests", async (c) => {
  const status = c.req.query("status"); // pending | approved | rejected | omitted for all
  const query = status
    ? c.env.DB.prepare(
        `SELECT rr.*, u.username FROM recharge_requests rr JOIN users u ON u.id = rr.user_id
         WHERE rr.status = ? ORDER BY rr.id DESC LIMIT 100`
      ).bind(status)
    : c.env.DB.prepare(
        `SELECT rr.*, u.username FROM recharge_requests rr JOIN users u ON u.id = rr.user_id
         ORDER BY rr.id DESC LIMIT 100`
      );
  const { results } = await query.all();
  return c.json({ requests: results });
});

admin.post("/recharge-requests/:id/approve", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const request = await c.env.DB.prepare("SELECT * FROM recharge_requests WHERE id = ?").bind(id).first();
  if (!request) return c.json({ error: "Request not found" }, 404);
  if (request.status !== "pending") return c.json({ error: `Request is already ${request.status}` }, 400);

  // Mark resolved first, guarded on still being pending, so two concurrent
  // approve/reject clicks can't both succeed against the same request.
  const claim = await c.env.DB.prepare(
    "UPDATE recharge_requests SET status = 'approved', admin_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'"
  ).bind(body.note || null, c.get("user").id, new Date().toISOString(), id).run();
  if (!claim.meta.changes) return c.json({ error: "Request was already resolved" }, 400);

  const balance = await adjustBalance(c.env.DB, request.user_id, request.amount, "recharge_approved", { requestId: id, note: body.note || null });
  return c.json({ ok: true, balance });
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

export default admin;
