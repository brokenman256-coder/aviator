-- Manual payment proof: user pays via UPI/bank, uploads a screenshot, admin approves.
ALTER TABLE recharge_requests ADD COLUMN amount_inr REAL;
ALTER TABLE recharge_requests ADD COLUMN payment_reference TEXT;
ALTER TABLE recharge_requests ADD COLUMN screenshot_mime TEXT;
ALTER TABLE recharge_requests ADD COLUMN screenshot_data TEXT;

INSERT INTO settings (key, value) VALUES ('payment_upi_id', '')
ON CONFLICT(key) DO NOTHING;

INSERT INTO settings (key, value) VALUES ('payment_instructions', 'Pay via UPI, then upload your payment screenshot below. Credits are added after admin approval.')
ON CONFLICT(key) DO NOTHING;
