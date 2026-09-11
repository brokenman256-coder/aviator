-- Zenith Markets trade module: simulated-price up/down contracts.
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

INSERT INTO settings (key, value) VALUES ('trade_min_stake', '10') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('trade_max_stake', '5000') ON CONFLICT(key) DO NOTHING;
