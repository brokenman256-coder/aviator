-- Razorpay online payments: tracks orders until payment is verified, then credits the wallet.
CREATE TABLE IF NOT EXISTS payment_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  razorpay_order_id TEXT NOT NULL UNIQUE,
  razorpay_payment_id TEXT UNIQUE,
  amount_inr REAL NOT NULL,
  amount_paise INTEGER NOT NULL,
  credits_to_add REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);

INSERT INTO settings (key, value) VALUES ('credits_per_rupee', '1')
ON CONFLICT(key) DO NOTHING;
