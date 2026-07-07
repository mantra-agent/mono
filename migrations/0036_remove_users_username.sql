ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_unique;
DROP INDEX IF EXISTS users_username_unique;
ALTER TABLE users DROP COLUMN IF EXISTS username;
