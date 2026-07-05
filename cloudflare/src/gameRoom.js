import { DurableObject } from "cloudflare:workers";
import { cyrb53 } from "./crypto-utils.js";
import { getNumberSetting, adjustBalance } from "./store.js";

const WAIT_MS = 5000;
const CRASH_FREEZE_MS = 2500;
const GROWTH_RATE = 0.00009; // multiplier = e^(GROWTH_RATE * elapsedMs), mirrored on the client for smooth interpolation
const TICK_MS = 100;
const MAX_CRASH_POINT = 5000;

function multiplierAt(elapsedMs) {
  return Math.exp(GROWTH_RATE * elapsedMs);
}

function betKey(userId, slot) {
  return `${userId}:${slot}`;
}

// A single global "room" that owns round state and ticks continuously while
// a round is in flight, broadcasting to every connected player's WebSocket.
// An active setInterval keeps this Durable Object resident in memory for the
// duration of gameplay, so there's no need for the WebSocket Hibernation API
// here — appropriate for a small private game, not a large multi-tenant one.
export class GameRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> { userId }
    this.phase = "waiting";
    this.phaseStart = Date.now();
    this.round = null;
    this.currentMultiplier = 1;
    this.activeBets = new Map(); // `${userId}:${slot}` -> bet record
    this.timer = null;
    this.started = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });

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

    this.ensureStarted();
    this.sendTo(server, { type: "round:state", ...this.publicState() });

    return new Response(null, { status: 101, webSocket: client });
  }

  ensureStarted() {
    if (this.started) return;
    this.started = true;
    this.beginWaiting();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  sendTo(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // socket already closed; will be cleaned up by the close handler
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

    try {
      if (data.type === "bet:place") {
        const result = await this.placeBet(userId, Number(data.slot) || 0, data.amount, data.autoCashout);
        this.sendTo(ws, { type: "bet:placed", ...result });
      } else if (data.type === "bet:cancel") {
        const result = await this.cancelBet(userId, Number(data.slot) || 0);
        this.sendTo(ws, { type: "bet:cancelled", ...result });
      } else if (data.type === "bet:cashout") {
        const result = await this.cashOut(userId, Number(data.slot) || 0);
        this.sendTo(ws, { type: "bet:cashed_out", ...result });
      }
    } catch (err) {
      this.sendTo(ws, { type: "bet:error", slot: data.slot, error: err.message });
    }
  }

  async generateCrashPoint(houseEdgePercent) {
    const seed = crypto.randomUUID() + Date.now().toString(36);
    const h = cyrb53(seed);
    const E = Math.pow(2, 53);

    let base;
    if (h % 33 === 0) {
      base = 1.0;
    } else {
      base = Math.floor((100 * E - h) / (E - h)) / 100;
      if (!isFinite(base) || base < 1) base = 1.0;
    }

    let crashPoint = Math.floor(base * (1 - houseEdgePercent / 100) * 100) / 100;
    crashPoint = Math.max(1.0, Math.min(crashPoint, MAX_CRASH_POINT));
    return { seed, hash: h.toString(16), crashPoint };
  }

  async beginWaiting() {
    this.phase = "waiting";
    this.phaseStart = Date.now();
    this.activeBets.clear();

    const houseEdgePercent = await getNumberSetting(this.env.DB, "house_edge_percent");
    const { seed, hash, crashPoint } = await this.generateCrashPoint(houseEdgePercent);

    const now = new Date().toISOString();
    const info = await this.env.DB.prepare(
      `INSERT INTO rounds (seed, hash, crash_point, house_edge_percent, started_at) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(seed, hash, crashPoint, houseEdgePercent, now)
      .run();

    this.round = { id: info.meta.last_row_id, seed, hash, crashPoint };
    this.currentMultiplier = 1;
    this.broadcast({ type: "round:waiting", roundId: this.round.id, waitMs: WAIT_MS });
  }

  beginRunning() {
    this.phase = "running";
    this.phaseStart = Date.now();
    this.broadcast({ type: "round:running", roundId: this.round.id });
  }

  async beginCrashed() {
    this.phase = "crashed";
    this.phaseStart = Date.now();
    this.currentMultiplier = this.round.crashPoint;

    for (const bet of this.activeBets.values()) {
      if (!bet.cashedOut) {
        await this.env.DB.prepare("UPDATE bets SET status = 'lost', payout = 0 WHERE id = ?").bind(bet.betId).run();
      }
    }
    await this.env.DB.prepare("UPDATE rounds SET ended_at = ? WHERE id = ?").bind(new Date().toISOString(), this.round.id).run();

    this.broadcast({ type: "round:crashed", roundId: this.round.id, crashPoint: this.round.crashPoint });
  }

  async tick() {
    const elapsed = Date.now() - this.phaseStart;

    if (this.phase === "waiting") {
      if (elapsed >= WAIT_MS) this.beginRunning();
    } else if (this.phase === "running") {
      const m = multiplierAt(elapsed);
      if (m >= this.round.crashPoint) {
        await this.beginCrashed();
      } else {
        this.currentMultiplier = m;
        this.broadcast({ type: "round:tick", multiplier: Number(m.toFixed(4)), elapsedMs: elapsed });
        await this.checkAutoCashouts(m);
      }
    } else if (this.phase === "crashed") {
      if (elapsed >= CRASH_FREEZE_MS) await this.beginWaiting();
    }
  }

  async checkAutoCashouts(multiplier) {
    for (const bet of this.activeBets.values()) {
      if (!bet.cashedOut && bet.autoCashout && multiplier >= bet.autoCashout) {
        await this.settleCashOut(bet, multiplier);
      }
    }
  }

  async placeBet(userId, slot, amount, autoCashout) {
    if (this.phase !== "waiting") throw new Error("Betting is closed for this round");
    const key = betKey(userId, slot);
    if (this.activeBets.has(key)) throw new Error("You already have a bet in this slot");

    amount = Math.round(Number(amount) * 100) / 100;
    const minBet = await getNumberSetting(this.env.DB, "min_bet");
    const maxBet = await getNumberSetting(this.env.DB, "max_bet");
    if (!isFinite(amount) || amount < minBet || amount > maxBet) {
      throw new Error(`Bet must be between ${minBet} and ${maxBet} credits`);
    }
    if (autoCashout !== null && autoCashout !== undefined) {
      autoCashout = Number(autoCashout);
      if (!isFinite(autoCashout) || autoCashout < 1.01) throw new Error("Auto cash-out target must be at least 1.01x");
    } else {
      autoCashout = null;
    }

    const newBalance = await adjustBalance(this.env.DB, userId, -amount, "bet", { roundId: this.round.id, slot });
    const now = new Date().toISOString();
    const info = await this.env.DB.prepare(
      `INSERT INTO bets (round_id, user_id, slot, amount, auto_cashout, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    )
      .bind(this.round.id, userId, slot, amount, autoCashout, now)
      .run();

    this.activeBets.set(key, {
      betId: info.meta.last_row_id,
      userId,
      slot,
      amount,
      autoCashout,
      cashedOut: false,
    });

    return { slot, balance: newBalance, betId: info.meta.last_row_id };
  }

  async cancelBet(userId, slot) {
    if (this.phase !== "waiting") throw new Error("Cannot cancel after betting has closed");
    const key = betKey(userId, slot);
    const bet = this.activeBets.get(key);
    if (!bet) throw new Error("No active bet to cancel");

    const newBalance = await adjustBalance(this.env.DB, userId, bet.amount, "bet_cancel", { roundId: this.round.id, slot });
    await this.env.DB.prepare("UPDATE bets SET status = 'cancelled' WHERE id = ?").bind(bet.betId).run();
    this.activeBets.delete(key);
    return { slot, balance: newBalance };
  }

  async cashOut(userId, slot) {
    if (this.phase !== "running") throw new Error("No round in progress");
    const key = betKey(userId, slot);
    const bet = this.activeBets.get(key);
    if (!bet || bet.cashedOut) throw new Error("No active bet to cash out");

    const elapsed = Date.now() - this.phaseStart;
    const multiplier = Math.min(multiplierAt(elapsed), this.round.crashPoint);
    return this.settleCashOut(bet, multiplier);
  }

  async settleCashOut(bet, multiplier) {
    bet.cashedOut = true;
    const payout = Math.round(bet.amount * multiplier * 100) / 100;
    const newBalance = await adjustBalance(this.env.DB, bet.userId, payout, "payout", {
      roundId: this.round.id,
      slot: bet.slot,
      multiplier,
    });
    await this.env.DB.prepare("UPDATE bets SET status = 'cashed_out', cashout_multiplier = ?, payout = ? WHERE id = ?")
      .bind(multiplier, payout, bet.betId)
      .run();

    const result = { slot: bet.slot, multiplier, payout, balance: newBalance };
    this.sendToUser(bet.userId, { type: "bet:cashed_out", ...result });
    return result;
  }

  publicState() {
    return {
      state: this.phase,
      multiplier: this.currentMultiplier,
      roundId: this.round ? this.round.id : null,
      msInPhase: Date.now() - this.phaseStart,
      waitMs: WAIT_MS,
    };
  }
}
