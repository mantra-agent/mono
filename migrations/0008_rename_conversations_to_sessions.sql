ALTER TABLE IF EXISTS "conversations" RENAME TO "sessions";
ALTER TABLE IF EXISTS "messages" RENAME COLUMN "conversation_id" TO "session_id";
ALTER INDEX IF EXISTS "conversations_pkey" RENAME TO "sessions_pkey";
