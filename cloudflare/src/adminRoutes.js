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
    minBet: Number(await getSetting(c.env.DB, "min_bet")),
    maxBet: Number(await getSetting(c.env.DB, "max_bet")),
  });
});

admin.post("/settings", async (c) => {
  const { houseEdgePercent, signupBonusCredits, minBet, maxBet } = await c.req.json().catch(() => ({}));
  if (houseEdgePercent !== undefined) {
    await setSetting(c.env.DB, "house_edge_percent", Math.min(50, Math.max(0, Number(houseEdgePercent))));
  }
  if (signupBonusCredits !== undefined) {
    await setSetting(c.env.DB, "signup_bonus_credits", Math.max(0, Number(signupBonusCredits)));
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

export default admin;
