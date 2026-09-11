const express = require("express");
const db = require("./db");
const { authRequired, adminRequired, ah } = require("./middleware");
const { adjustBalance, getSetting, setSetting, publicUser } = require("./store");
const { listAssets, createAsset, updateAsset } = require("./trade");

const router = express.Router();
router.use(authRequired, adminRequired);

router.get(
  "/users",
  ah(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM users ORDER BY id DESC");
    res.json({ users: rows.map(publicUser) });
  })
);

router.post(
  "/users/:id/adjust",
  ah(async (req, res) => {
    const userId = Number(req.params.id);
    const delta = Number(req.body?.amount);
    const reason = req.body?.reason || null;
    if (!isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: "amount must be a non-zero number" });
    }
    try {
      const balance = await adjustBalance(userId, delta, "admin_adjust", { reason, adminId: req.user.id });
      res.json({ balance });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

router.post(
  "/users/:id/ban",
  ah(async (req, res) => {
    const banned = !!req.body?.banned;
    await db.query("UPDATE users SET is_banned = $1 WHERE id = $2", [banned, req.params.id]);
    res.json({ ok: true });
  })
);

router.post(
  "/users/:id/admin",
  ah(async (req, res) => {
    const isAdmin = !!req.body?.isAdmin;
    await db.query("UPDATE users SET is_admin = $1 WHERE id = $2", [isAdmin, req.params.id]);
    res.json({ ok: true });
  })
);

router.get(
  "/settings",
  ah(async (req, res) => {
    res.json({
      houseEdgePercent: Number(await getSetting("house_edge_percent")),
      signupBonusCredits: Number(await getSetting("signup_bonus_credits")),
      minBet: Number(await getSetting("min_bet")),
      maxBet: Number(await getSetting("max_bet")),
    });
  })
);

router.post(
  "/settings",
  ah(async (req, res) => {
    const { houseEdgePercent, signupBonusCredits, minBet, maxBet } = req.body || {};
    if (houseEdgePercent !== undefined) await setSetting("house_edge_percent", Math.min(50, Math.max(0, Number(houseEdgePercent))));
    if (signupBonusCredits !== undefined) await setSetting("signup_bonus_credits", Math.max(0, Number(signupBonusCredits)));
    if (minBet !== undefined) await setSetting("min_bet", Math.max(1, Number(minBet)));
    if (maxBet !== undefined) await setSetting("max_bet", Math.max(1, Number(maxBet)));
    res.json({ ok: true });
  })
);

router.get(
  "/stats",
  ah(async (req, res) => {
    const { rows } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'bet' THEN -amount ELSE 0 END), 0) AS wagered,
        COALESCE(SUM(CASE WHEN type = 'payout' THEN amount ELSE 0 END), 0) AS "paidOut",
        COALESCE(SUM(CASE WHEN type = 'signup_bonus' THEN amount ELSE 0 END), 0) AS "bonusesGiven",
        COALESCE(SUM(CASE WHEN type = 'admin_adjust' THEN amount ELSE 0 END), 0) AS "adminAdjustments"
      FROM wallet_transactions
    `);
    const totals = rows[0];
    const { rows: userCountRows } = await db.query("SELECT COUNT(*)::int AS c FROM users");
    const { rows: roundCountRows } = await db.query("SELECT COUNT(*)::int AS c FROM rounds WHERE ended_at IS NOT NULL");

    res.json({
      ...totals,
      houseProfit: Math.round((totals.wagered - totals.paidOut) * 100) / 100,
      userCount: userCountRows[0].c,
      roundCount: roundCountRows[0].c,
    });
  })
);

router.get(
  "/rounds",
  ah(async (req, res) => {
    const { rows } = await db.query("SELECT * FROM rounds ORDER BY id DESC LIMIT 50");
    res.json({ rounds: rows });
  })
);

// ---------- Zenith Markets trade module ----------

router.get(
  "/trade/assets",
  ah(async (req, res) => {
    res.json({ assets: await listAssets({ includeDisabled: true }) });
  })
);

router.post(
  "/trade/assets",
  ah(async (req, res) => {
    const { symbol, name, price, volatility, payoutPercent } = req.body || {};
    if (!symbol || !name || !isFinite(Number(price))) {
      return res.status(400).json({ error: "symbol, name, and a numeric price are required" });
    }
    try {
      const asset = await createAsset({
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
  })
);

router.post(
  "/trade/assets/:id",
  ah(async (req, res) => {
    try {
      const asset = await updateAsset(Number(req.params.id), req.body || {});
      res.json({ asset });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

router.get(
  "/trade/settings",
  ah(async (req, res) => {
    res.json({
      minStake: Number(await getSetting("trade_min_stake")),
      maxStake: Number(await getSetting("trade_max_stake")),
    });
  })
);

router.post(
  "/trade/settings",
  ah(async (req, res) => {
    const { minStake, maxStake } = req.body || {};
    if (minStake !== undefined) await setSetting("trade_min_stake", Math.max(1, Number(minStake)));
    if (maxStake !== undefined) await setSetting("trade_max_stake", Math.max(1, Number(maxStake)));
    res.json({ ok: true });
  })
);

router.get(
  "/trade/contracts",
  ah(async (req, res) => {
    const { rows } = await db.query(`
      SELECT c.*, a.symbol, u.username FROM trade_contracts c
      JOIN trade_assets a ON a.id = c.asset_id
      JOIN users u ON u.id = c.user_id
      ORDER BY c.id DESC LIMIT 50
    `);
    res.json({ contracts: rows });
  })
);

router.get(
  "/trade/stats",
  ah(async (req, res) => {
    const { rows } = await db.query(`
      SELECT
        COALESCE(SUM(stake), 0) AS staked,
        COALESCE(SUM(CASE WHEN status = 'won' THEN payout ELSE 0 END), 0) AS "paidOut",
        COALESCE(SUM(CASE WHEN status IN ('won', 'lost') THEN 1 ELSE 0 END), 0)::int AS "settledCount"
      FROM trade_contracts
    `);
    const totals = rows[0];
    res.json({ ...totals, houseProfit: Math.round((totals.staked - totals.paidOut) * 100) / 100 });
  })
);

module.exports = router;
