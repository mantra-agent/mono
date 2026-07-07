-- Remove account-scoped Comms cache rows for Google accounts that are no longer connected.
-- This repairs stale email pipeline state left behind by the prior Gmail disconnect flow.

WITH orphan_accounts AS (
  SELECT account_id FROM email_sync_cursors
  UNION
  SELECT account_id FROM email_messages
  UNION
  SELECT account_id FROM email_enrichments
  UNION
  SELECT account_id FROM email_dismissals
  UNION
  SELECT account_id FROM email_drafts
  UNION
  SELECT account_id FROM email_triage_log
  UNION
  SELECT account_id FROM email_sync_log
), disconnected AS (
  SELECT account_id
  FROM orphan_accounts
  WHERE account_id NOT IN (
    SELECT account_id FROM connected_accounts WHERE provider = 'google'
  )
)
DELETE FROM email_triage_log WHERE account_id IN (SELECT account_id FROM disconnected);

WITH orphan_accounts AS (
  SELECT account_id FROM email_sync_cursors
  UNION SELECT account_id FROM email_messages
  UNION SELECT account_id FROM email_enrichments
  UNION SELECT account_id FROM email_dismissals
  UNION SELECT account_id FROM email_drafts
  UNION SELECT account_id FROM email_sync_log
), disconnected AS (
  SELECT account_id FROM orphan_accounts
  WHERE account_id NOT IN (SELECT account_id FROM connected_accounts WHERE provider = 'google')
)
DELETE FROM email_dismissals WHERE account_id IN (SELECT account_id FROM disconnected);

WITH orphan_accounts AS (
  SELECT account_id FROM email_sync_cursors
  UNION SELECT account_id FROM email_messages
  UNION SELECT account_id FROM email_enrichments
  UNION SELECT account_id FROM email_drafts
  UNION SELECT account_id FROM email_sync_log
), disconnected AS (
  SELECT account_id FROM orphan_accounts
  WHERE account_id NOT IN (SELECT account_id FROM connected_accounts WHERE provider = 'google')
)
DELETE FROM email_enrichments WHERE account_id IN (SELECT account_id FROM disconnected);

WITH orphan_accounts AS (
  SELECT account_id FROM email_sync_cursors
  UNION SELECT account_id FROM email_messages
  UNION SELECT account_id FROM email_drafts
  UNION SELECT account_id FROM email_sync_log
), disconnected AS (
  SELECT account_id FROM orphan_accounts
  WHERE account_id NOT IN (SELECT account_id FROM connected_accounts WHERE provider = 'google')
)
DELETE FROM email_drafts WHERE account_id IN (SELECT account_id FROM disconnected);

WITH orphan_accounts AS (
  SELECT account_id FROM email_sync_cursors
  UNION SELECT account_id FROM email_messages
  UNION SELECT account_id FROM email_sync_log
), disconnected AS (
  SELECT account_id FROM orphan_accounts
  WHERE account_id NOT IN (SELECT account_id FROM connected_accounts WHERE provider = 'google')
)
DELETE FROM email_messages WHERE account_id IN (SELECT account_id FROM disconnected);

WITH orphan_accounts AS (
  SELECT account_id FROM email_sync_cursors
  UNION SELECT account_id FROM email_sync_log
), disconnected AS (
  SELECT account_id FROM orphan_accounts
  WHERE account_id NOT IN (SELECT account_id FROM connected_accounts WHERE provider = 'google')
)
DELETE FROM email_sync_cursors WHERE account_id IN (SELECT account_id FROM disconnected);

WITH orphan_accounts AS (
  SELECT account_id FROM email_sync_log
), disconnected AS (
  SELECT account_id FROM orphan_accounts
  WHERE account_id NOT IN (SELECT account_id FROM connected_accounts WHERE provider = 'google')
)
DELETE FROM email_sync_log WHERE account_id IN (SELECT account_id FROM disconnected);
