-- Meeting Recap Distribution Repair (Step 3)
-- Adds idempotency constraint and lifecycle timestamps for distribution state tracking.

-- Add unique constraint for idempotency
ALTER TABLE meeting_recap_distributions
ADD CONSTRAINT unique_mrd_session_attendee UNIQUE (account_id, session_id, attendee_email);

-- Add timestamps for state transitions
ALTER TABLE meeting_recap_distributions
ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS discarded_at TIMESTAMP WITH TIME ZONE;

-- Backfill: convert sendgrid rows to failed state (no automatic send allowed)
UPDATE meeting_recap_distributions
SET status = 'failed', 
    error = 'automatic_send_disabled',
    updated_at = CURRENT_TIMESTAMP
WHERE send_method = 'sendgrid' AND status IN ('sent', 'pending');

-- Index for polling/monitoring (statuses that need action)
CREATE INDEX IF NOT EXISTS idx_mrd_status_account 
ON meeting_recap_distributions(account_id, status)
WHERE status != 'sent' AND status != 'discarded';
