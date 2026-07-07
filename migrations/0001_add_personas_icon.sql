ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "icon" TEXT NOT NULL DEFAULT 'Bot';

UPDATE "personas" SET "icon" = 'User' WHERE "name" = 'Default' AND "source" = 'seed' AND "icon" = 'Bot';
UPDATE "personas" SET "icon" = 'Shield' WHERE "name" = 'Strategist' AND "source" = 'seed' AND "icon" = 'Bot';
UPDATE "personas" SET "icon" = 'Trophy' WHERE "name" = 'Coach' AND "source" = 'seed' AND "icon" = 'Bot';
UPDATE "personas" SET "icon" = 'Zap' WHERE "name" = 'Operator' AND "source" = 'seed' AND "icon" = 'Bot';
UPDATE "personas" SET "icon" = 'Palette' WHERE "name" = 'Creative' AND "source" = 'seed' AND "icon" = 'Bot';
UPDATE "personas" SET "icon" = 'Heart' WHERE "name" = 'Companion' AND "source" = 'seed' AND "icon" = 'Bot';
