const express = require("express");
const db = require("./db");
const { authRequired, adminRequired } = require("./middleware");
const { adjustBalance, getSetting, setSetting, publicUser } = require("./store");
const { listAssets, createAsset, updateAsset } = require("./trade");

const router = express.Router();
router.use(authRequired, adminRequired);

router.get("/users", (req, res) => {
  const users = db.prepare("SELECT * FROM users ORDER BY id DESC").all();
  res.json({ users: users.map(publicUser) });
});

router.post("/users/:id/adjust", (req, res) => {
  const userId = Number(req.params.id);
  const delta = Number(req.body?.amount);
  const reason = req.body?.reason || null;
  if (!isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: "amount must be a non-zero number" });
  }
  try {
    const balance = adjustBalance(userId, delta, "admin_adjust", { reason, adminId: req.user.id });
    res.json({ balance });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/users/:id/ban", (req, res) => {
  const banned = req.body?.banned ? 1 : 0;
  db.prepare("UPDATE users SET is_banned = ? WHERE id = ?").run(banned, req.params.id);
  res.json({ ok: true });
});

router.post("/users/:id/admin", (req, res) => {
  const isAdmin = req.body?.isAdmin ? 1 : 0;
  db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin, req.params.id);
  res.json({ ok: true });
});

router.get("/settings", (req, res) => {
  res.json({
    houseEdgePercent: Number(getSetting("house_edge_percent")),
    signupBonusCredits: Number(getSetting("signup_bonus_credits")),
    minBet: Number(getSetting("min_bet")),
    maxBet: Number(getSetting("max_bet")),
  });
});

router.post("/settings", (req, res) => {
  const { houseEdgePercent, signupBonusCredits, minBet, maxBet } = req.body || {};
  if (houseEdgePercent !== undefined) {
    setSetting("house_edge_percent", Math.min(50, Math.max(0, Number(houseEdgePercent))));
  }
  if (signupBonusCredits !== undefined) {
    setSetting("signup_bonus_credits", Math.max(0, Number(signupBonusCredits)));
  }
  if (minBet !== undefined) setSetting("min_bet", Math.max(1, Number(minBet)));
  if (maxBet !== undefined) setSetting("max_bet", Math.max(1, Number(maxBet)));
  res.json({ ok: true });
});

router.get("/stats", (req, res) => {
  const totals = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'bet' THEN -amount ELSE 0 END), 0) AS wagered,
        COALESCE(SUM(CASE WHEN type = 'payout' THEN amount ELSE 0 END), 0) AS paidOut,
        COALESCE(SUM(CASE WHEN type = 'signup_bonus' THEN amount ELSE 0 END), 0) AS bonusesGiven,
        COALESCE(SUM(CASE WHEN type = 'admin_adjust' THEN amount ELSE 0 END), 0) AS adminAdjustments
      FROM wallet_transactions`
    )
    .get();

  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  const roundCount = db.prepare("SELECT COUNT(*) AS c FROM rounds WHERE ended_at IS NOT NULL").get().c;

  res.json({
    ...totals,
    houseProfit: Math.round((totals.wagered - totals.paidOut) * 100) / 100,
    userCount,
    roundCount,
  });
});

router.get("/rounds", (req, res) => {
  const rounds = db.prepare("SELECT * FROM rounds ORDER BY id DESC LIMIT 50").all();
  res.json({ rounds });
});

// ---------- Zenith Markets trade module ----------

router.get("/trade/assets", (req, res) => {
  res.json({ assets: listAssets({ includeDisabled: true }) });
});

router.post("/trade/assets", (req, res) => {
  const { symbol, name, price, volatility, payoutPercent } = req.body || {};
  if (!symbol || !name || !isFinite(Number(price))) {
    return res.status(400).json({ error: "symbol, name, and a numeric price are required" });
  }
  try {
    const asset = createAsset({
      symbol: String(symbol).toUpperCase(),
      name,
      price: Number(price),
      volatility: Number(volatility) || 0.001,
      payoutPercent: Number(payoutPercent) || 80,
    });
    res.json({ asset });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/trade/assets/:id", (req, res) => {
  try {
    const asset = updateAsset(Number(req.params.id), req.body || {});
    res.json({ asset });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/trade/settings", (req, res) => {
  res.json({
    minStake: Number(getSetting("trade_min_stake")),
    maxStake: Number(getSetting("trade_max_stake")),
  });
});

router.post("/trade/settings", (req, res) => {
  const { minStake, maxStake } = req.body || {};
  if (minStake !== undefined) setSetting("trade_min_stake", Math.max(1, Number(minStake)));
  if (maxStake !== undefined) setSetting("trade_max_stake", Math.max(1, Number(maxStake)));
  res.json({ ok: true });
});

router.get("/trade/contracts", (req, res) => {
  const contracts = db
    .prepare(
      `SELECT c.*, a.symbol, u.username FROM trade_contracts c
       JOIN trade_assets a ON a.id = c.asset_id
       JOIN users u ON u.id = c.user_id
       ORDER BY c.id DESC LIMIT 50`
    )
    .all();
  res.json({ contracts });
});

router.get("/trade/stats", (req, res) => {
  const totals = db
    .prepare(
      `SELECT
        COALESCE(SUM(stake), 0) AS staked,
        COALESCE(SUM(CASE WHEN status = 'won' THEN payout ELSE 0 END), 0) AS paidOut,
        COALESCE(SUM(CASE WHEN status IN ('won', 'lost') THEN 1 ELSE 0 END), 0) AS settledCount
      FROM trade_contracts`
    )
    .get();
  res.json({ ...totals, houseProfit: Math.round((totals.staked - totals.paidOut) * 100) / 100 });
});

module.exports = router;
