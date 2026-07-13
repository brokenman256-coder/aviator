const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

// DATA_DIR lets a deployment point this at a mounted persistent volume
// (e.g. Railway), so the database survives redeploys instead of living on
// the container's ephemeral filesystem.
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "aviator.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    is_verified INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_banned INTEGER NOT NULL DEFAULT 0,
    balance REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seed TEXT NOT NULL,
    hash TEXT NOT NULL,
    crash_point REAL NOT NULL,
    house_edge_percent REAL NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );

  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    slot INTEGER NOT NULL DEFAULT 0,
    amount REAL NOT NULL,
    auto_cashout REAL,
    status TEXT NOT NULL DEFAULT 'active',
    cashout_multiplier REAL,
    payout REAL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    balance_after REAL NOT NULL,
    meta TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trade_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    volatility REAL NOT NULL DEFAULT 0.0006,
    payout_percent REAL NOT NULL DEFAULT 80,
    enabled INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS trade_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    stake REAL NOT NULL,
    open_price REAL NOT NULL,
    close_price REAL,
    payout_percent REAL NOT NULL,
    duration_sec INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    payout REAL,
    opened_at TEXT NOT NULL,
    closes_at TEXT NOT NULL,
    settled_at TEXT
  );
`);

module.exports = db;
