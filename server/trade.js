const express = require("express");
const db = require("./db");
const { authRequired } = require("./middleware");
const { getNumberSetting, adjustBalance } = require("./store");

const TICK_MS = 1000;
const ALLOWED_DURATIONS_SEC = [30, 60, 120, 300];

// Starter instruments for the demo price feed. Prices move via an in-process
// random walk — there is no live market data source wired in yet. Swapping
// `_advancePrice` below for a real feed (or a broker/liquidity provider API)
// is the integration point for turning this from a demo into a live platform.
const SEED_ASSETS = [
  { symbol: "ZEN100", name: "Zenith 100 Index", price: 1000, volatility: 0.0015, payoutPercent: 85 },
  { symbol: "GOLD", name: "Gold Spot", price: 2350, volatility: 0.0008, payoutPercent: 82 },
  { symbol: "BTCUSD", name: "Bitcoin / USD", price: 61000, volatility: 0.003, payoutPercent: 78 },
  { symbol: "EURUSD", name: "Euro / US Dollar", price: 1.085, volatility: 0.0004, payoutPercent: 85 },
  { symbol: "OIL", name: "Crude Oil", price: 82, volatility: 0.0012, payoutPercent: 80 },
];

function seedAssets() {
  const count = db.prepare("SELECT COUNT(*) AS c FROM trade_assets").get().c;
  if (count > 0) return;
  const insert = db.prepare(
    `INSERT INTO trade_assets (symbol, name, price, volatility, payout_percent, enabled)
     VALUES (?, ?, ?, ?, ?, 1)`
  );
  for (const a of SEED_ASSETS) insert.run(a.symbol, a.name, a.price, a.volatility, a.payoutPercent);
}

function publicAsset(a) {
  return {
    id: a.id,
    symbol: a.symbol,
    name: a.name,
    price: a.price,
    payoutPercent: a.payout_percent,
    enabled: !!a.enabled,
  };
}

function listAssets({ includeDisabled = false } = {}) {
  const rows = includeDisabled
    ? db.prepare("SELECT * FROM trade_assets ORDER BY id").all()
    : db.prepare("SELECT * FROM trade_assets WHERE enabled = 1 ORDER BY id").all();
  return rows.map(publicAsset);
}

function createAsset({ symbol, name, price, volatility, payoutPercent }) {
  const info = db
    .prepare(
      `INSERT INTO trade_assets (symbol, name, price, volatility, payout_percent, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`
    )
    .run(symbol, name, price, volatility, payoutPercent);
  return db.prepare("SELECT * FROM trade_assets WHERE id = ?").get(info.lastInsertRowid);
}

function updateAsset(id, { name, volatility, payoutPercent, enabled }) {
  const asset = db.prepare("SELECT * FROM trade_assets WHERE id = ?").get(id);
  if (!asset) throw new Error("Asset not found");
  db.prepare(
    `UPDATE trade_assets SET name = ?, volatility = ?, payout_percent = ?, enabled = ? WHERE id = ?`
  ).run(
    name !== undefined ? name : asset.name,
    volatility !== undefined ? Number(volatility) : asset.volatility,
    payoutPercent !== undefined ? Number(payoutPercent) : asset.payout_percent,
    enabled !== undefined ? (enabled ? 1 : 0) : asset.enabled,
    id
  );
  return db.prepare("SELECT * FROM trade_assets WHERE id = ?").get(id);
}

class TradeEngine {
  constructor(io) {
    this.io = io;
    this.openContracts = new Map(); // contractId -> row snapshot
  }

  start() {
    seedAssets();
    this._loadOpenContracts();
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  _loadOpenContracts() {
    const rows = db.prepare("SELECT * FROM trade_contracts WHERE status = 'open'").all();
    for (const row of rows) this.openContracts.set(row.id, row);
  }

  _advancePrice(asset) {
    const delta = (Math.random() - 0.5) * 2 * asset.volatility;
    const next = asset.price * (1 + delta);
    return Math.max(next, 0.0001);
  }

  _tick() {
    const assets = db.prepare("SELECT * FROM trade_assets WHERE enabled = 1").all();
    const prices = {};
    for (const asset of assets) {
      const next = this._advancePrice(asset);
      db.prepare("UPDATE trade_assets SET price = ? WHERE id = ?").run(next, asset.id);
      prices[asset.symbol] = next;
    }
    this.io.emit("trade:price", { prices, ts: Date.now() });
    this._settleDue();
  }

  _settleDue() {
    const now = Date.now();
    for (const [id, contract] of this.openContracts) {
      if (new Date(contract.closes_at).getTime() > now) continue;

      const asset = db.prepare("SELECT * FROM trade_assets WHERE id = ?").get(contract.asset_id);
      const closePrice = asset.price;
      const won =
        (contract.direction === "up" && closePrice > contract.open_price) ||
        (contract.direction === "down" && closePrice < contract.open_price);
      // A close price exactly equal to the open price counts as a loss, same
      // as a tie going to the house in the crash game's edge — documented
      // here since it's not visually obvious from the contract result alone.
      const payout = won ? Math.round(contract.stake * (1 + contract.payout_percent / 100) * 100) / 100 : 0;
      const settledAt = new Date().toISOString();

      db.prepare(
        `UPDATE trade_contracts SET close_price = ?, status = ?, payout = ?, settled_at = ? WHERE id = ?`
      ).run(closePrice, won ? "won" : "lost", payout, settledAt, id);

      let balance = null;
      if (payout > 0) {
        balance = adjustBalance(contract.user_id, payout, "trade_payout", {
          contractId: id,
          symbol: asset.symbol,
        });
      } else {
        const user = db.prepare("SELECT balance FROM users WHERE id = ?").get(contract.user_id);
        balance = user ? user.balance : null;
      }

      this.openContracts.delete(id);
      this.io.to(`user:${contract.user_id}`).emit("trade:closed", {
        contractId: id,
        symbol: asset.symbol,
        direction: contract.direction,
        won,
        openPrice: contract.open_price,
        closePrice,
        stake: contract.stake,
        payout,
        balance,
      });
    }
  }

  openContract(userId, symbol, direction, stake, durationSec) {
    if (direction !== "up" && direction !== "down") throw new Error("Direction must be 'up' or 'down'");
    durationSec = Number(durationSec);
    if (!ALLOWED_DURATIONS_SEC.includes(durationSec)) {
      throw new Error(`Duration must be one of: ${ALLOWED_DURATIONS_SEC.join(", ")} seconds`);
    }

    const asset = db.prepare("SELECT * FROM trade_assets WHERE symbol = ? AND enabled = 1").get(symbol);
    if (!asset) throw new Error("Unknown or disabled instrument");

    stake = Math.round(Number(stake) * 100) / 100;
    const minStake = getNumberSetting("trade_min_stake");
    const maxStake = getNumberSetting("trade_max_stake");
    if (!isFinite(stake) || stake < minStake || stake > maxStake) {
      throw new Error(`Stake must be between ${minStake} and ${maxStake} credits`);
    }

    const newBalance = adjustBalance(userId, -stake, "trade_open", { symbol, direction });
    const now = new Date();
    const closesAt = new Date(now.getTime() + durationSec * 1000);

    const info = db
      .prepare(
        `INSERT INTO trade_contracts
          (user_id, asset_id, direction, stake, open_price, payout_percent, duration_sec, status, opened_at, closes_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(userId, asset.id, direction, stake, asset.price, asset.payout_percent, durationSec, now.toISOString(), closesAt.toISOString());

    const contract = db.prepare("SELECT * FROM trade_contracts WHERE id = ?").get(info.lastInsertRowid);
    this.openContracts.set(contract.id, contract);

    return {
      contractId: contract.id,
      symbol: asset.symbol,
      direction,
      stake,
      openPrice: asset.price,
      payoutPercent: asset.payout_percent,
      closesAt: closesAt.toISOString(),
      balance: newBalance,
    };
  }
}

const router = express.Router();

router.get("/assets", authRequired, (req, res) => {
  res.json({ assets: listAssets() });
});

router.get("/history", authRequired, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, a.symbol, a.name AS asset_name FROM trade_contracts c
       JOIN trade_assets a ON a.id = c.asset_id
       WHERE c.user_id = ? ORDER BY c.id DESC LIMIT 30`
    )
    .all(req.user.id);
  res.json({ contracts: rows });
});

module.exports = { router, TradeEngine, listAssets, createAsset, updateAsset, ALLOWED_DURATIONS_SEC };
