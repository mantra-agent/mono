ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS company_id TEXT;
CREATE INDEX IF NOT EXISTS idx_opportunities_company_id ON opportunities(company_id);
