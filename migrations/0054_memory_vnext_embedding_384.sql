-- Align vNext claim embeddings with the canonical local memory embedding producer.
-- server/memory/embedding.ts exports EMBEDDING_MODEL=all-MiniLM-L6-v2 and EMBEDDING_DIMENSIONS=384.
-- This table is vNext-only; legacy memory/workspace vector columns are intentionally untouched.

ALTER TABLE memory_vnext_claims
  ALTER COLUMN embedding TYPE vector(384)
  USING NULL;

DROP INDEX IF EXISTS idx_memory_vnext_claim_embedding;
CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_embedding
  ON memory_vnext_claims
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
