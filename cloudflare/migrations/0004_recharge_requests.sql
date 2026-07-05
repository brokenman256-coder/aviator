-- Self-serve "add credit" flow: a player submits a request, an admin
-- approves or rejects it. Approval is the only path that ever touches a
-- balance (via the same atomic adjustBalance() used everywhere else).
CREATE TABLE IF NOT EXISTS recharge_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  admin_note TEXT,
  resolved_by INTEGER,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recharge_requests_status ON recharge_requests(status);
CREATE INDEX IF NOT EXISTS idx_recharge_requests_user ON recharge_requests(user_id);
