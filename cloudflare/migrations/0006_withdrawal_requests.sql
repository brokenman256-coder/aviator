-- Reuse the same pending/approve/reject flow as recharge requests, just in
-- the other direction: approving a 'withdrawal' request debits instead of
-- credits. Still entirely inside the virtual-credit ledger — approval never
-- triggers any real-world money movement.
ALTER TABLE recharge_requests ADD COLUMN type TEXT NOT NULL DEFAULT 'recharge';
