const crypto = require("crypto");
const db = require("./db");
const { cyrb53 } = require("./crypto-utils");
const { getNumberSetting, adjustBalance } = require("./store");

const WAIT_MS = 5000;
const CRASH_FREEZE_MS = 2500;
const GROWTH_RATE = 0.00009; // multiplier = e^(GROWTH_RATE * elapsedMs), shared with the client for smooth interpolation
const TICK_MS = 100;
const MAX_CRASH_POINT = 5000;

function multiplierAt(elapsedMs) {
  return Math.exp(GROWTH_RATE * elapsedMs);
}

function betKey(userId, slot) {
  return `${userId}:${slot}`;
}

class GameEngine {
  constructor(io) {
    this.io = io;
    this.state = "waiting";
    this.phaseStart = Date.now();
    this.round = null;
    this.currentMultiplier = 1;
    this.activeBets = new Map(); // `${userId}:${slot}` -> { betId, userId, slot, amount, autoCashout, cashedOut }
  }

  start() {
    this._beginWaiting();
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  // Derives this round's crash point from a fresh random seed. The base value
  // comes from the standard crash-game hash formula; it is then scaled down by
  // the configured house edge so the operator has a transparent, tunable
  // statistical edge rather than any per-round manipulation of who wins.
  _generateCrashPoint(houseEdgePercent) {
    const seed = crypto.randomBytes(12).toString("hex") + Date.now().toString(36);
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

  _beginWaiting() {
    this.state = "waiting";
    this.phaseStart = Date.now();
    this.activeBets.clear();

    const houseEdgePercent = getNumberSetting("house_edge_percent");
    const { seed, hash, crashPoint } = this._generateCrashPoint(houseEdgePercent);

    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO rounds (seed, hash, crash_point, house_edge_percent, started_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(seed, hash, crashPoint, houseEdgePercent, now);

    this.round = { id: info.lastInsertRowid, seed, hash, crashPoint };
    this.currentMultiplier = 1;
    this.io.emit("round:waiting", { roundId: this.round.id, waitMs: WAIT_MS });
  }

  _beginRunning() {
    this.state = "running";
    this.phaseStart = Date.now();
    this.io.emit("round:running", { roundId: this.round.id });
  }

  _beginCrashed() {
    this.state = "crashed";
    this.phaseStart = Date.now();
    this.currentMultiplier = this.round.crashPoint;

    for (const bet of this.activeBets.values()) {
      if (!bet.cashedOut) {
        db.prepare("UPDATE bets SET status = 'lost', payout = 0 WHERE id = ?").run(bet.betId);
      }
    }
    db.prepare("UPDATE rounds SET ended_at = ? WHERE id = ?").run(new Date().toISOString(), this.round.id);

    this.io.emit("round:crashed", { roundId: this.round.id, crashPoint: this.round.crashPoint });
  }

  _tick() {
    const elapsed = Date.now() - this.phaseStart;

    if (this.state === "waiting") {
      if (elapsed >= WAIT_MS) this._beginRunning();
    } else if (this.state === "running") {
      const m = multiplierAt(elapsed);
      if (m >= this.round.crashPoint) {
        this._beginCrashed();
      } else {
        this.currentMultiplier = m;
        this.io.emit("round:tick", { multiplier: Number(m.toFixed(4)), elapsedMs: elapsed });
        this._checkAutoCashouts(m);
      }
    } else if (this.state === "crashed") {
      if (elapsed >= CRASH_FREEZE_MS) this._beginWaiting();
    }
  }

  _checkAutoCashouts(multiplier) {
    for (const bet of this.activeBets.values()) {
      if (!bet.cashedOut && bet.autoCashout && multiplier >= bet.autoCashout) {
        this._settleCashOut(bet, multiplier);
      }
    }
  }

  placeBet(userId, slot, amount, autoCashout) {
    if (this.state !== "waiting") throw new Error("Betting is closed for this round");
    const key = betKey(userId, slot);
    if (this.activeBets.has(key)) throw new Error("You already have a bet in this slot");

    amount = Math.round(Number(amount) * 100) / 100;
    const minBet = getNumberSetting("min_bet");
    const maxBet = getNumberSetting("max_bet");
    if (!isFinite(amount) || amount < minBet || amount > maxBet) {
      throw new Error(`Bet must be between ${minBet} and ${maxBet} credits`);
    }
    if (autoCashout !== null && autoCashout !== undefined) {
      autoCashout = Number(autoCashout);
      if (!isFinite(autoCashout) || autoCashout < 1.01) throw new Error("Auto cash-out target must be at least 1.01x");
    } else {
      autoCashout = null;
    }

    const newBalance = adjustBalance(userId, -amount, "bet", { roundId: this.round.id, slot });
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO bets (round_id, user_id, slot, amount, auto_cashout, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      )
      .run(this.round.id, userId, slot, amount, autoCashout, now);

    this.activeBets.set(key, {
      betId: info.lastInsertRowid,
      userId,
      slot,
      amount,
      autoCashout,
      cashedOut: false,
    });

    return { slot, balance: newBalance, betId: info.lastInsertRowid };
  }

  cancelBet(userId, slot) {
    if (this.state !== "waiting") throw new Error("Cannot cancel after betting has closed");
    const key = betKey(userId, slot);
    const bet = this.activeBets.get(key);
    if (!bet) throw new Error("No active bet to cancel");

    const newBalance = adjustBalance(userId, bet.amount, "bet_cancel", { roundId: this.round.id, slot });
    db.prepare("UPDATE bets SET status = 'cancelled' WHERE id = ?").run(bet.betId);
    this.activeBets.delete(key);
    return { slot, balance: newBalance };
  }

  cashOut(userId, slot) {
    if (this.state !== "running") throw new Error("No round in progress");
    const key = betKey(userId, slot);
    const bet = this.activeBets.get(key);
    if (!bet || bet.cashedOut) throw new Error("No active bet to cash out");

    const elapsed = Date.now() - this.phaseStart;
    const multiplier = Math.min(multiplierAt(elapsed), this.round.crashPoint);
    return this._settleCashOut(bet, multiplier);
  }

  _settleCashOut(bet, multiplier) {
    bet.cashedOut = true;
    const payout = Math.round(bet.amount * multiplier * 100) / 100;
    const newBalance = adjustBalance(bet.userId, payout, "payout", {
      roundId: this.round.id,
      slot: bet.slot,
      multiplier,
    });
    db.prepare("UPDATE bets SET status = 'cashed_out', cashout_multiplier = ?, payout = ? WHERE id = ?").run(
      multiplier,
      payout,
      bet.betId
    );

    const result = { slot: bet.slot, multiplier, payout, balance: newBalance };
    this.io.to(`user:${bet.userId}`).emit("bet:cashed_out", result);
    return result;
  }

  publicState() {
    return {
      state: this.state,
      multiplier: this.currentMultiplier,
      roundId: this.round ? this.round.id : null,
      msInPhase: Date.now() - this.phaseStart,
      waitMs: WAIT_MS,
    };
  }
}

module.exports = { GameEngine, multiplierAt };
