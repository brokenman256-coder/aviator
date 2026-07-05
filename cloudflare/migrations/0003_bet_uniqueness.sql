-- Belt-and-suspenders against duplicate bets for the same round/user/slot:
-- even if application-level guards were ever bypassed (a bug, a retried
-- request), the database itself refuses a second active bet in the same slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_active_unique
  ON bets(round_id, user_id, slot)
  WHERE status = 'active';
