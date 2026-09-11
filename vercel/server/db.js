const { Pool } = require("pg");
const config = require("./config");

if (!config.DATABASE_URL) {
  console.warn("[db] DATABASE_URL is not set — every query will fail until it's configured.");
}

// Small pool size: serverless functions spin up many short-lived instances,
// each holding its own pool, so keep per-instance connections low. Use a
// pooled connection string (e.g. Neon's "pooled" endpoint, or PgBouncer) from
// your Postgres provider if you see "too many connections" errors in
// production.
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(config.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 3,
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    is_verified BOOLEAN NOT NULL DEFAULT false,
    is_admin BOOLEAN NOT NULL DEFAULT false,
    is_banned BOOLEAN NOT NULL DEFAULT false,
    balance DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    code TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id SERIAL PRIMARY KEY,
    seed TEXT NOT NULL,
    hash TEXT NOT NULL,
    crash_point DOUBLE PRECISION NOT NULL,
    house_edge_percent DOUBLE PRECISION NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS bets (
    id SERIAL PRIMARY KEY,
    round_id INTEGER NOT NULL REFERENCES rounds(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    slot INTEGER NOT NULL DEFAULT 0,
    amount DOUBLE PRECISION NOT NULL,
    auto_cashout DOUBLE PRECISION,
    status TEXT NOT NULL DEFAULT 'active',
    cashout_multiplier DOUBLE PRECISION,
    payout DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
    balance_after DOUBLE PRECISION NOT NULL,
    meta TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS trade_assets (
    id SERIAL PRIMARY KEY,
    symbol TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    price DOUBLE PRECISION NOT NULL,
    volatility DOUBLE PRECISION NOT NULL DEFAULT 0.0006,
    payout_percent DOUBLE PRECISION NOT NULL DEFAULT 80,
    enabled BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS trade_contracts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    asset_id INTEGER NOT NULL REFERENCES trade_assets(id),
    direction TEXT NOT NULL,
    stake DOUBLE PRECISION NOT NULL,
    open_price DOUBLE PRECISION NOT NULL,
    close_price DOUBLE PRECISION,
    payout_percent DOUBLE PRECISION NOT NULL,
    duration_sec INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    payout DOUBLE PRECISION,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closes_at TIMESTAMPTZ NOT NULL,
    settled_at TIMESTAMPTZ
  );
`;

// Cached across warm invocations of the same serverless instance so a
// schema check doesn't run on every single request — only on cold start.
let readyPromise = null;
function ensureSchema() {
  if (!readyPromise) {
    readyPromise = pool.query(SCHEMA).catch((err) => {
      readyPromise = null; // allow retry on next call if this failed
      throw err;
    });
  }
  return readyPromise;
}

async function query(text, params) {
  await ensureSchema();
  return pool.query(text, params);
}

// Runs `fn(client)` inside a transaction, committing on success and rolling
// back on any thrown error. Used wherever a read-then-write needs to be
// atomic across concurrent serverless invocations (balance adjustments,
// price catch-up, contract settlement).
async function withTransaction(fn) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, withTransaction, pool };
