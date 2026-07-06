-- New accounts no longer get a signup bonus — players earn their starting
-- credits from the once-a-day spin wheel instead.
UPDATE settings SET value = '0' WHERE key = 'signup_bonus_credits';
INSERT INTO settings (key, value) VALUES ('signup_bonus_credits', '0')
  ON CONFLICT(key) DO NOTHING;

-- Records each daily-wheel claim. The UNIQUE(user_id, claim_date) index is the
-- atomic guard that a player can spin at most once per calendar day: the spin
-- endpoint does an INSERT OR IGNORE and treats "no row inserted" as "already
-- claimed today", so concurrent spin requests can't double-award.
CREATE TABLE IF NOT EXISTS daily_bonus_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  claim_date TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_claim_user_date
  ON daily_bonus_claims(user_id, claim_date);
