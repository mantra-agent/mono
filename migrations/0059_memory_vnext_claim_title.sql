-- Add short display title to vNext claims (1-3 words, extracted at claim creation)
ALTER TABLE memory_vnext_claims ADD COLUMN IF NOT EXISTS title TEXT;
