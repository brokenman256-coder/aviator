ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN referred_by INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

INSERT INTO settings (key, value) VALUES
  ('referral_bonus_credits', '500')
ON CONFLICT(key) DO NOTHING;
