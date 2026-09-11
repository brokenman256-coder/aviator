const crypto = require("crypto");
const db = require("./db");
const { cyrb53 } = require("./crypto-utils");
const { getNumberSetting, adjustBalance } = require("./store");

// This is a serverless-friendly rewrite of the original Socket.io-driven
// GameEngine: there is no persistent process to run a tick loop, so round
// phase/multiplier are pure functions of elapsed wall-clock time, computed
// fresh on every request instead of being pushed from a background timer.
// A new round is created lazily — whichever request notices the previous
// round's freeze window has ended rotates to a fresh one, under an advisory
// lock so concurrent requests don't create two rounds at once.

const WAIT_MS = 5000;
const CRASH_FREEZE_MS = 2500;
const GROWTH_RATE = 0.00009; // multiplier = e^(GROWTH_RATE * elapsedMs), shared with the client for smooth interpolation
const MAX_CRASH_POINT = 5000;
const ROUND_LOCK_KEY = 727001;

function multiplierAt(elapsedMs) {
  return Math.exp(GROWTH_RATE * elapsedMs);
}

function generateCrashPoint(houseEdgePercent) {
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

// Derives the round's phase (and when that phase began) purely from
// started_at + crash_point — no stored "current state" needed.
function phaseOf(round, now) {
  const started = new Date(round.started_at).getTime();
  const waitEnd = started + WAIT_MS;
  const crashElapsedMs = Math.log(round.crash_point) / GROWTH_RATE;
  const runEnd = waitEnd + crashElapsedMs;
  const freezeEnd = runEnd + CRASH_FREEZE_MS;

  if (now < waitEnd) return { phase: "waiting", phaseStart: started };
  if (now < runEnd) return { phase: "running", phaseStart: waitEnd };
  if (now < freezeEnd) return { phase: "crashed", phaseStart: runEnd };
  return { phase: "done", phaseStart: freezeEnd };
}

async function ensureActiveRound() {
  return db.withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [ROUND_LOCK_KEY]);

    const { rows } = await client.query("SELECT * FROM rounds ORDER BY id DESC LIMIT 1");
    const current = rows[0];
    const now = Date.now();

    if (current) {
      const { phase } = phaseOf(current, now);
      if (phase !== "done") return current;
      if (!current.ended_at) {
        await client.query("UPDATE rounds SET ended_at = now() WHERE id = $1", [current.id]);
        await client.query(
          "UPDATE bets SET status = 'lost', payout = 0 WHERE round_id = $1 AND status = 'active'",
          [current.id]
        );
      }
    }

    const houseEdgePercent = await getNumberSetting("house_edge_percent");
    const { seed, hash, crashPoint } = generateCrashPoint(houseEdgePercent);
    const { rows: inserted } = await client.query(
      `INSERT INTO rounds (seed, hash, crash_point, house_edge_percent, started_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING *`,
      [seed, hash, crashPoint, houseEdgePercent]
    );
    return inserted[0];
  });
}

// Auto cash-out targets can only be checked when something asks for state,
// since there's no background loop watching the multiplier. Any client
// polling /api/game/state while a round is running drives this — in
// practice that's every connected player, every ~250ms, so targets fire
// within roughly a poll interval of being crossed rather than instantly.
async function settleAutoCashouts(round, now) {
  const { phase, phaseStart } = phaseOf(round, now);
  if (phase !== "running") return;
  const multiplier = Math.min(multiplierAt(now - phaseStart), round.crash_point);

  const { rows } = await db.query(
    `SELECT * FROM bets WHERE round_id = $1 AND status = 'active' AND auto_cashout IS NOT NULL AND auto_cashout <= $2`,
    [round.id, multiplier]
  );

  for (const bet of rows) {
    try {
      await db.withTransaction(async (client) => {
        const { rows: locked } = await client.query(
          "UPDATE bets SET status = 'cashed_out' WHERE id = $1 AND status = 'active' RETURNING *",
          [bet.id]
        );
        if (!locked.length) return; // a concurrent request already settled it

        const payout = Math.round(bet.amount * bet.auto_cashout * 100) / 100;
        const { rows: userRows } = await client.query("SELECT balance FROM users WHERE id = $1 FOR UPDATE", [bet.user_id]);
        const newBalance = Math.round((userRows[0].balance + payout) * 100) / 100;
        await client.query("UPDATE users SET balance = $1 WHERE id = $2", [newBalance, bet.user_id]);
        await client.query("UPDATE bets SET cashout_multiplier = $1, payout = $2 WHERE id = $3", [
          bet.auto_cashout,
          payout,
          bet.id,
        ]);
        await client.query(
          `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, meta, created_at)
           VALUES ($1, 'payout', $2, $3, $4, now())`,
          [bet.user_id, payout, newBalance, JSON.stringify({ roundId: round.id, slot: bet.slot, multiplier: bet.auto_cashout })]
        );
      });
    } catch (err) {
      console.error("[game] auto-cashout settle failed for bet", bet.id, err);
    }
  }
}

async function getRoundState(userId) {
  const round = await ensureActiveRound();
  const now = Date.now();
  await settleAutoCashouts(round, now);

  const { phase, phaseStart } = phaseOf(round, now);
  const elapsed = now - phaseStart;
  const multiplier = phase === "waiting" ? 1 : Math.min(multiplierAt(elapsed), round.crash_point);

  const { rows: myBets } = await db.query(
    "SELECT slot, amount, status, cashout_multiplier, payout FROM bets WHERE round_id = $1 AND user_id = $2",
    [round.id, userId]
  );

  return {
    state: phase,
    multiplier,
    roundId: round.id,
    msInPhase: elapsed,
    waitMs: WAIT_MS,
    crashPoint: phase === "crashed" ? round.crash_point : null,
    myBets: myBets.map((b) => ({
      slot: b.slot,
      amount: b.amount,
      status: b.status,
      cashoutMultiplier: b.cashout_multiplier,
      payout: b.payout,
    })),
  };
}

async function getHistory() {
  const { rows } = await db.query(
    "SELECT crash_point FROM rounds WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT 20"
  );
  return rows.map((r) => r.crash_point);
}

async function placeBet(userId, slot, amount, autoCashout) {
  const round = await ensureActiveRound();
  const { phase } = phaseOf(round, Date.now());
  if (phase !== "waiting") throw new Error("Betting is closed for this round");

  amount = Math.round(Number(amount) * 100) / 100;
  const minBet = await getNumberSetting("min_bet");
  const maxBet = await getNumberSetting("max_bet");
  if (!isFinite(amount) || amount < minBet || amount > maxBet) {
    throw new Error(`Bet must be between ${minBet} and ${maxBet} credits`);
  }

  if (autoCashout !== null && autoCashout !== undefined) {
    autoCashout = Number(autoCashout);
    if (!isFinite(autoCashout) || autoCashout < 1.01) throw new Error("Auto cash-out target must be at least 1.01x");
  } else {
    autoCashout = null;
  }

  const { rows: existing } = await db.query(
    "SELECT id FROM bets WHERE round_id = $1 AND user_id = $2 AND slot = $3",
    [round.id, userId, slot]
  );
  if (existing.length) throw new Error("You already have a bet in this slot");

  const newBalance = await adjustBalance(userId, -amount, "bet", { roundId: round.id, slot });

  try {
    const { rows } = await db.query(
      `INSERT INTO bets (round_id, user_id, slot, amount, auto_cashout, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'active', now()) RETURNING id`,
      [round.id, userId, slot, amount, autoCashout]
    );
    return { slot, balance: newBalance, betId: rows[0].id, roundId: round.id };
  } catch (err) {
    // Unique constraint caught a race against a concurrent request for the
    // same slot — refund the bet we just debited and surface a clean error.
    await adjustBalance(userId, amount, "bet_cancel", { roundId: round.id, slot, reason: "race" });
    if (err.code === "23505") throw new Error("You already have a bet in this slot");
    throw err;
  }
}

async function cancelBet(userId, slot) {
  const round = await ensureActiveRound();
  const { phase } = phaseOf(round, Date.now());
  if (phase !== "waiting") throw new Error("Cannot cancel after betting has closed");

  const { rows } = await db.query(
    "SELECT * FROM bets WHERE round_id = $1 AND user_id = $2 AND slot = $3 AND status = 'active'",
    [round.id, userId, slot]
  );
  const bet = rows[0];
  if (!bet) throw new Error("No active bet to cancel");

  const newBalance = await adjustBalance(userId, bet.amount, "bet_cancel", { roundId: round.id, slot });
  await db.query("UPDATE bets SET status = 'cancelled' WHERE id = $1", [bet.id]);
  return { slot, balance: newBalance };
}

async function cashOut(userId, slot) {
  const round = await ensureActiveRound();
  const now = Date.now();
  const { phase, phaseStart } = phaseOf(round, now);
  if (phase !== "running") throw new Error("No round in progress");

  const { rows } = await db.query(
    "SELECT * FROM bets WHERE round_id = $1 AND user_id = $2 AND slot = $3 AND status = 'active'",
    [round.id, userId, slot]
  );
  const bet = rows[0];
  if (!bet) throw new Error("No active bet to cash out");

  const multiplier = Math.min(multiplierAt(now - phaseStart), round.crash_point);
  const payout = Math.round(bet.amount * multiplier * 100) / 100;
  const newBalance = await adjustBalance(userId, payout, "payout", { roundId: round.id, slot, multiplier });
  await db.query("UPDATE bets SET status = 'cashed_out', cashout_multiplier = $1, payout = $2 WHERE id = $3", [
    multiplier,
    payout,
    bet.id,
  ]);
  return { slot, multiplier, payout, balance: newBalance };
}

module.exports = { getRoundState, getHistory, placeBet, cancelBet, cashOut, multiplierAt, WAIT_MS };
