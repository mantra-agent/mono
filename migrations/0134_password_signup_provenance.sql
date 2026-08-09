ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_signup_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_password_signup_at
  ON users(password_signup_at)
  WHERE password_signup_at IS NOT NULL;

COMMENT ON COLUMN users.password_signup_at IS
  'Canonical completed password-signup time. NULL means not proven or historically unavailable; never infer from password hash or user creation time.';
