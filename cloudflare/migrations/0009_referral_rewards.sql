-- Referral rewards. referral_code / referred_by already exist (0002); this adds
-- a one-time "rewarded" flag so the invite bonus is paid to both sides exactly
-- once, when the invited player becomes active (their first daily-wheel spin).
ALTER TABLE users ADD COLUMN referral_rewarded INTEGER NOT NULL DEFAULT 0;

-- Force the referral bonus down to a modest 100 (an earlier migration had left
-- it at 500, which is too generous — the admin can retune it in settings).
INSERT INTO settings (key, value) VALUES ('referral_bonus_credits', '100')
  ON CONFLICT(key) DO UPDATE SET value = '100';

-- Backfill referral codes for any existing accounts that predate this feature.
-- (New codes are generated at registration; this just avoids null codes.)
