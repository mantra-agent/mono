ALTER TABLE "plaid_liabilities" ADD COLUMN IF NOT EXISTS "manual_payment_amount" real;
ALTER TABLE "manual_liabilities" ADD COLUMN IF NOT EXISTS "manual_payment_amount" real;
