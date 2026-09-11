const express = require("express");
const db = require("./db");
const { authRequired, ah } = require("./middleware");
const { getNumberSetting, adjustBalance } = require("./store");

// Serverless-friendly rewrite of the Socket.io-driven TradeEngine: there's no
// persistent process to tick prices forward every second, so each asset's
// price is advanced on read via a "catch-up" random walk — however many
// 1-second ticks have elapsed since it was last touched (capped, so a long
// idle gap doesn't loop thousands of times) — and persisted back atomically
// under a row lock. Contract settlement is similarly lazy: any request that
// touches trade state also sweeps up and settles contracts whose expiry has
// passed. There is still no live market data feed wired in — see SEED_ASSETS
// below for where a real feed would plug in.
const TICK_MS = 1000;
const MAX_CATCHUP_TICKS = 120;
const ALLOWED_DURATIONS_SEC = [30, 60, 120, 300];

const SEED_ASSETS = [
  { symbol: "ZEN100", name: "Zenith 100 Index", price: 1000, volatility: 0.0015, payoutPercent: 85 },
  { symbol: "GOLD", name: "Gold Spot", price: 2350, volatility: 0.0008, payoutPercent: 82 },
  { symbol: "BTCUSD", name: "Bitcoin / USD", price: 61000, volatility: 0.003, payoutPercent: 78 },
  { symbol: "EURUSD", name: "Euro / US Dollar", price: 1.085, volatility: 0.0004, payoutPercent: 85 },
  { symbol: "OIL", name: "Crude Oil", price: 82, volatility: 0.0012, payoutPercent: 80 },
];

let seededPromise = null;
function ensureSeeded() {
  if (!seededPromise) {
    seededPromise = (async () => {
      const { rows } = await db.query("SELECT COUNT(*)::int AS c FROM trade_assets");
      if (rows[0].c > 0) return;
      for (const a of SEED_ASSETS) {
        await db.query(
          `INSERT INTO trade_assets (symbol, name, price, volatility, payout_percent, enabled, updated_at)
           VALUES ($1, $2, $3, $4, $5, true, now())
           ON CONFLICT (symbol) DO NOTHING`,
          [a.symbol, a.name, a.price, a.volatility, a.payoutPercent]
        );
      }
    })().catch((err) => {
      seededPromise = null;
      throw err;
    });
  }
  return seededPromise;
}

function publicAsset(a) {
  return { id: a.id, symbol: a.symbol, name: a.name, price: a.price, payoutPercent: a.payout_percent, enabled: !!a.enabled };
}

function advancedPrice(asset, now) {
  const lastUpdate = new Date(asset.updated_at).getTime();
  let ticks = Math.floor((now - lastUpdate) / TICK_MS);
  if (ticks <= 0) return { price: asset.price, updatedAt: asset.updated_at };

  const cappedIdle = ticks > MAX_CATCHUP_TICKS;
  ticks = Math.min(ticks, MAX_CATCHUP_TICKS);

  let price = asset.price;
  for (let i = 0; i < ticks; i++) {
    const delta = (Math.random() - 0.5) * 2 * asset.volatility;
    price = Math.max(price * (1 + delta), 0.0001);
  }
  const updatedAt = cappedIdle ? new Date(now).toISOString() : new Date(lastUpdate + ticks * TICK_MS).toISOString();
  return { price, updatedAt };
}

// Advances and persists every enabled asset's price, returning {symbol: price}.
async function getPrices() {
  await ensureSeeded();
  return db.withTransaction(async (client) => {
    const { rows: assets } = await client.query("SELECT * FROM trade_assets WHERE enabled = true ORDER BY id FOR UPDATE");
    const now = Date.now();
    const prices = {};
    for (const asset of assets) {
      const { price, updatedAt } = advancedPrice(asset, now);
      if (price !== asset.price) {
        await client.query("UPDATE trade_assets SET price = $1, updated_at = $2 WHERE id = $3", [price, updatedAt, asset.id]);
      }
      prices[asset.symbol] = price;
    }
    return prices;
  });
}

async function settleDueContracts() {
  const { rows: due } = await db.query("SELECT * FROM trade_contracts WHERE status = 'open' AND closes_at <= now()");
  const results = [];

  for (const contract of due) {
    try {
      const result = await db.withTransaction(async (client) => {
        const { rows: assetRows } = await client.query("SELECT * FROM trade_assets WHERE id = $1", [contract.asset_id]);
        const asset = assetRows[0];
        const closePrice = asset.price;
        const won =
          (contract.direction === "up" && closePrice > contract.open_price) ||
          (contract.direction === "down" && closePrice < contract.open_price);
        const payout = won ? Math.round(contract.stake * (1 + contract.payout_percent / 100) * 100) / 100 : 0;

        const { rows: updated } = await client.query(
          `UPDATE trade_contracts SET close_price = $1, status = $2, payout = $3, settled_at = now()
           WHERE id = $4 AND status = 'open' RETURNING *`,
          [closePrice, won ? "won" : "lost", payout, contract.id]
        );
        if (!updated.length) return null; // a concurrent request already settled it

        let balance = null;
        if (payout > 0) {
          const { rows: userRows } = await client.query("SELECT balance FROM users WHERE id = $1 FOR UPDATE", [contract.user_id]);
          balance = Math.round((userRows[0].balance + payout) * 100) / 100;
          await client.query("UPDATE users SET balance = $1 WHERE id = $2", [balance, contract.user_id]);
          await client.query(
            `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, meta, created_at)
             VALUES ($1, 'trade_payout', $2, $3, $4, now())`,
            [contract.user_id, payout, balance, JSON.stringify({ contractId: contract.id, symbol: asset.symbol })]
          );
        }

        return {
          contractId: contract.id,
          userId: contract.user_id,
          symbol: asset.symbol,
          direction: contract.direction,
          won,
          openPrice: contract.open_price,
          closePrice,
          stake: contract.stake,
          payout,
          balance,
        };
      });
      if (result) results.push(result);
    } catch (err) {
      console.error("[trade] settle failed for contract", contract.id, err);
    }
  }
  return results;
}

function listAssets({ includeDisabled = false } = {}) {
  return ensureSeeded().then(() =>
    db
      .query(includeDisabled ? "SELECT * FROM trade_assets ORDER BY id" : "SELECT * FROM trade_assets WHERE enabled = true ORDER BY id")
      .then(({ rows }) => rows.map(publicAsset))
  );
}

async function createAsset({ symbol, name, price, volatility, payoutPercent }) {
  const { rows } = await db.query(
    `INSERT INTO trade_assets (symbol, name, price, volatility, payout_percent, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, true, now()) RETURNING *`,
    [symbol, name, price, volatility, payoutPercent]
  );
  return publicAsset(rows[0]);
}

async function updateAsset(id, { name, volatility, payoutPercent, enabled }) {
  const { rows: existing } = await db.query("SELECT * FROM trade_assets WHERE id = $1", [id]);
  const asset = existing[0];
  if (!asset) throw new Error("Asset not found");
  const { rows } = await db.query(
    `UPDATE trade_assets SET name = $1, volatility = $2, payout_percent = $3, enabled = $4 WHERE id = $5 RETURNING *`,
    [
      name !== undefined ? name : asset.name,
      volatility !== undefined ? Number(volatility) : asset.volatility,
      payoutPercent !== undefined ? Number(payoutPercent) : asset.payout_percent,
      enabled !== undefined ? !!enabled : asset.enabled,
      id,
    ]
  );
  return publicAsset(rows[0]);
}

async function openContract(userId, symbol, direction, stake, durationSec) {
  await ensureSeeded();
  if (direction !== "up" && direction !== "down") throw new Error("Direction must be 'up' or 'down'");
  durationSec = Number(durationSec);
  if (!ALLOWED_DURATIONS_SEC.includes(durationSec)) {
    throw new Error(`Duration must be one of: ${ALLOWED_DURATIONS_SEC.join(", ")} seconds`);
  }

  stake = Math.round(Number(stake) * 100) / 100;
  const minStake = await getNumberSetting("trade_min_stake");
  const maxStake = await getNumberSetting("trade_max_stake");
  if (!isFinite(stake) || stake < minStake || stake > maxStake) {
    throw new Error(`Stake must be between ${minStake} and ${maxStake} credits`);
  }

  const openPrice = await db.withTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM trade_assets WHERE symbol = $1 AND enabled = true FOR UPDATE", [symbol]);
    const asset = rows[0];
    if (!asset) throw new Error("Unknown or disabled instrument");
    const { price, updatedAt } = advancedPrice(asset, Date.now());
    if (price !== asset.price) {
      await client.query("UPDATE trade_assets SET price = $1, updated_at = $2 WHERE id = $3", [price, updatedAt, asset.id]);
    }
    return { price, asset };
  });

  const { price, asset } = openPrice;
  const newBalance = await adjustBalance(userId, -stake, "trade_open", { symbol, direction });
  const closesAt = new Date(Date.now() + durationSec * 1000).toISOString();

  const { rows: inserted } = await db.query(
    `INSERT INTO trade_contracts
      (user_id, asset_id, direction, stake, open_price, payout_percent, duration_sec, status, opened_at, closes_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'open', now(), $8) RETURNING id`,
    [userId, asset.id, direction, stake, price, asset.payout_percent, durationSec, closesAt]
  );

  return {
    contractId: inserted[0].id,
    symbol: asset.symbol,
    direction,
    stake,
    openPrice: price,
    payoutPercent: asset.payout_percent,
    closesAt,
    balance: newBalance,
  };
}

const router = express.Router();

router.get(
  "/assets",
  authRequired,
  ah(async (req, res) => {
    res.json({ assets: await listAssets() });
  })
);

// Advances prices, settles anything due, and returns live state + the
// caller's own open/settled contracts — the endpoint every connected client
// polls every ~1s in place of the old Socket.io push events.
router.get(
  "/state",
  authRequired,
  ah(async (req, res) => {
    const prices = await getPrices();
    const settled = await settleDueContracts();

    const { rows: openRows } = await db.query(
      `SELECT c.*, a.symbol FROM trade_contracts c JOIN trade_assets a ON a.id = c.asset_id
       WHERE c.user_id = $1 AND c.status = 'open' ORDER BY c.id DESC`,
      [req.user.id]
    );

    res.json({
      prices,
      openContracts: openRows.map((c) => ({
        contractId: c.id,
        symbol: c.symbol,
        direction: c.direction,
        stake: c.stake,
        closesAt: c.closes_at,
      })),
      justSettled: settled.filter((s) => s.userId === req.user.id),
    });
  })
);

router.post(
  "/open",
  authRequired,
  ah(async (req, res) => {
    try {
      const { symbol, direction, stake, durationSec } = req.body || {};
      const result = await openContract(req.user.id, symbol, direction, stake, durationSec);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

router.get(
  "/history",
  authRequired,
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.*, a.symbol, a.name AS asset_name FROM trade_contracts c
       JOIN trade_assets a ON a.id = c.asset_id
       WHERE c.user_id = $1 ORDER BY c.id DESC LIMIT 30`,
      [req.user.id]
    );
    res.json({ contracts: rows });
  })
);

module.exports = { router, listAssets, createAsset, updateAsset, getPrices, settleDueContracts, ALLOWED_DURATIONS_SEC };
