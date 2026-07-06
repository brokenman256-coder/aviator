-- Consecutive-day spin streak. Updated by the daily-wheel spin endpoint:
-- spinning on the day after your last spin increments the streak, any gap
-- resets it to 1. A streak bonus is paid on top of the wheel prize.
ALTER TABLE users ADD COLUMN daily_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_spin_date TEXT;
