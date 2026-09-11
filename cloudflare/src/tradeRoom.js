import { DurableObject } from "cloudflare:workers";
import { getNumberSetting, adjustBalance } from "./store.js";

const TICK_MS = 1000;

// Starter instruments for the demo price feed. Prices move via an in-process
// random walk — there is no live market data source wired in yet. Swapping
// `advancePrices` below for a real feed (or a broker/liquidity provider API)
// is the integration point for turning this from a demo into a live platform.
const SEED_ASSETS = [
  { symbol: "ZEN100", name: "Zenith 100 Index", price: 1000, volatility: 0.0015, payoutPercent: 85 },
  { symbol: "GOLD", name: "Gold Spot", price: 2350, volatility: 0.0008, payoutPercent: 82 },
  { symbol: "BTCUSD", name: "Bitcoin / USD", price: 61000, volatility: 0.003, payoutPercent: 78 },
  { symbol: "EURUSD", name: "Euro / US Dollar", price: 1.085, volatility: 0.0004, payoutPercent: 85 },
  { symbol: "OIL", name: "Crude Oil", price: 82, volatility: 0.0012, payoutPercent: 80 },
];

// A single global "room", same pattern as GameRoom: it owns instrument prices
// and open contracts, ticks continuously while at least the object is warm,
// and broadcasts to every connected player's WebSocket. See GameRoom's own
// comment for why an active setInterval (rather than Hibernation) is fine
// here — this is a small private app, not a large multi-tenant one.
export class TradeRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> { userId }
    this.assets = new Map(); // symbol -> { id, symbol, name, price, volatility, payoutPercent, enabled }
    this.timer = null;
    this.started = false;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Reached only via the Worker's already-admin-gated routes
    // (adminRoutes.js calls stub.fetch() directly after writing to D1) —
    // refreshes this object's in-memory asset cache so a payout%/enabled/
    // volatility change takes effect immediately instead of waiting for the
    // Durable Object to restart.
    if (url.pathname === "/admin/reload-assets" && request.method === "POST") {
      await this.loadAssets();
      return Response.json({ ok: true });
    }

    if (url.pathname !== "/ws-trade") return new Response("Not found", { status: 404 });

    const token = url.searchParams.get("token");
    let userId;
    try {
      const { verifyJwt } = await import("./crypto-utils.js");
      const payload = await verifyJwt(token, this.env.JWT_SECRET);
      const user = await this.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.uid).first();
      if (!user || user.is_banned) throw new Error("unauthorized");
      userId = user.id;
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sessions.set(server, { userId });

    server.addEventListener("message", (event) => this.handleMessage(server, userId, event.data));
    server.addEventListener("close", () => this.sessions.delete(server));
    server.addEventListener("error", () => this.sessions.delete(server));

    await this.ensureStarted();
    this.sendTo(server, { type: "trade:assets", assets: this.publicAssets() });

    return new Response(null, { status: 101, webSocket: client });
  }

  async ensureStarted() {
    if (this.started) return;
    this.started = true;
    await this.seedAssets();
    await this.loadAssets();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  async seedAssets() {
    const { count } = await this.env.DB.prepare("SELECT COUNT(*) AS count FROM trade_assets").first();
    if (count > 0) return;
    for (const a of SEED_ASSETS) {
      await this.env.DB.prepare(
        `INSERT INTO trade_assets (symbol, name, price, volatility, payout_percent, enabled)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
        .bind(a.symbol, a.name, a.price, a.volatility, a.payoutPercent)
        .run();
    }
  }

  async loadAssets() {
    const { results } = await this.env.DB.prepare("SELECT * FROM trade_assets").all();
    this.assets.clear();
    for (const row of results) this.assets.set(row.symbol, row);
  }

  publicAssets() {
    return Array.from(this.assets.values())
      .filter((a) => a.enabled)
      .map((a) => ({ id: a.id, symbol: a.symbol, name: a.name, price: a.price, payoutPercent: a.payout_percent }));
  }

  sendTo(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // socket already closed; cleaned up by the close handler
    }
  }

  broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const ws of this.sessions.keys()) {
      try {
        ws.send(msg);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }

  sendToUser(userId, payload) {
    for (const [ws, session] of this.sessions.entries()) {
      if (session.userId === userId) this.sendTo(ws, payload);
    }
  }

  async handleMessage(ws, userId, raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (data.type !== "trade:open") return;
    try {
      const result = await this.openContract(userId, data.symbol, data.direction, data.stake, data.durationSec);
      this.sendTo(ws, { type: "trade:opened", ...result });
    } catch (err) {
      this.sendTo(ws, { type: "trade:error", error: err.message });
    }
  }

  async tick() {
    await this.advancePrices();
    this.broadcast({ type: "trade:price", prices: this.pricesObject() });
    await this.settleDue();
  }

  async advancePrices() {
    for (const asset of this.assets.values()) {
      if (!asset.enabled) continue;
      const delta = (Math.random() - 0.5) * 2 * asset.volatility;
      const next = Math.max(asset.price * (1 + delta), 0.0001);
      asset.price = next;
      await this.env.DB.prepare("UPDATE trade_assets SET price = ? WHERE id = ?").bind(next, asset.id).run();
    }
  }

  pricesObject() {
    const out = {};
    for (const asset of this.assets.values()) out[asset.symbol] = asset.price;
    return out;
  }

  async settleDue() {
    const now = new Date().toISOString();
    const { results: due } = await this.env.DB.prepare(
      "SELECT * FROM trade_contracts WHERE status = 'open' AND closes_at <= ?"
    )
      .bind(now)
      .all();

    for (const contract of due) {
      const asset = Array.from(this.assets.values()).find((a) => a.id === contract.asset_id);
      const closePrice = asset ? asset.price : contract.open_price;
      const won =
        (contract.direction === "up" && closePrice > contract.open_price) ||
        (contract.direction === "down" && closePrice < contract.open_price);
      const payout = won ? Math.round(contract.stake * (1 + contract.payout_percent / 100) * 100) / 100 : 0;
      const settledAt = new Date().toISOString();

      await this.env.DB.prepare(
        `UPDATE trade_contracts SET close_price = ?, status = ?, payout = ?, settled_at = ? WHERE id = ?`
      )
        .bind(closePrice, won ? "won" : "lost", payout, settledAt, contract.id)
        .run();

      let balance = null;
      if (payout > 0) {
        balance = await adjustBalance(this.env.DB, contract.user_id, payout, "trade_payout", {
          contractId: contract.id,
          symbol: asset ? asset.symbol : null,
        });
      } else {
        const user = await this.env.DB.prepare("SELECT balance FROM users WHERE id = ?").bind(contract.user_id).first();
        balance = user ? user.balance : null;
      }

      this.sendToUser(contract.user_id, {
        type: "trade:closed",
        contractId: contract.id,
        symbol: asset ? asset.symbol : null,
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

  async openContract(userId, symbol, direction, stake, durationSec) {
    const ALLOWED_DURATIONS_SEC = [30, 60, 120, 300];
    if (direction !== "up" && direction !== "down") throw new Error("Direction must be 'up' or 'down'");
    durationSec = Number(durationSec);
    if (!ALLOWED_DURATIONS_SEC.includes(durationSec)) {
      throw new Error(`Duration must be one of: ${ALLOWED_DURATIONS_SEC.join(", ")} seconds`);
    }

    const asset = this.assets.get(symbol);
    if (!asset || !asset.enabled) throw new Error("Unknown or disabled instrument");

    stake = Math.round(Number(stake) * 100) / 100;
    const minStake = await getNumberSetting(this.env.DB, "trade_min_stake");
    const maxStake = await getNumberSetting(this.env.DB, "trade_max_stake");
    if (!isFinite(stake) || stake < minStake || stake > maxStake) {
      throw new Error(`Stake must be between ${minStake} and ${maxStake} credits`);
    }

    const newBalance = await adjustBalance(this.env.DB, userId, -stake, "trade_open", { symbol, direction });
    const now = new Date();
    const closesAt = new Date(now.getTime() + durationSec * 1000).toISOString();

    const info = await this.env.DB.prepare(
      `INSERT INTO trade_contracts
        (user_id, asset_id, direction, stake, open_price, payout_percent, duration_sec, status, opened_at, closes_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
      .bind(userId, asset.id, direction, stake, asset.price, asset.payout_percent, durationSec, now.toISOString(), closesAt)
      .run();

    return {
      contractId: info.meta.last_row_id,
      symbol: asset.symbol,
      direction,
      stake,
      openPrice: asset.price,
      payoutPercent: asset.payout_percent,
      closesAt,
      balance: newBalance,
    };
  }
}
