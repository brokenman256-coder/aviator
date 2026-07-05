-- Unique, required phone number per account: primarily an anti-multi-account
-- measure (a banned player can't just sign up again under a new email).
ALTER TABLE users ADD COLUMN phone TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- Site-wide banner (admin-configurable image + text), shown to every player.
-- image_data_url holds a full data: URI (small images only, no separate
-- object storage needed for something this simple).
CREATE TABLE IF NOT EXISTS banner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  image_data_url TEXT,
  title TEXT,
  message TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
INSERT INTO banner (id, enabled) VALUES (1, 0) ON CONFLICT(id) DO NOTHING;

-- Player review/feedback submissions, visible to admins.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
