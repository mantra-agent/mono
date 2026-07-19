ALTER TABLE document_store_cutover_state
  ADD COLUMN IF NOT EXISTS independent_activation_requested_at TIMESTAMPTZ(6);

CREATE OR REPLACE FUNCTION enforce_document_store_cutover_monotonic()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.independent_writes_enabled AND NOT NEW.independent_writes_enabled THEN
    RAISE EXCEPTION 'independent document-store ownership cannot be reverted';
  END IF;
  IF OLD.independent_activation_requested_at IS NOT NULL
     AND NEW.independent_activation_requested_at IS DISTINCT FROM OLD.independent_activation_requested_at THEN
    RAISE EXCEPTION 'independent activation request is immutable';
  END IF;
  IF OLD.independent_started_at IS NOT NULL
     AND NEW.independent_started_at IS DISTINCT FROM OLD.independent_started_at THEN
    RAISE EXCEPTION 'independent activation timestamp is immutable';
  END IF;
  IF OLD.legacy_workspace_row_count IS NOT NULL
     AND NEW.legacy_workspace_row_count IS DISTINCT FROM OLD.legacy_workspace_row_count THEN
    RAISE EXCEPTION 'independent legacy row baseline is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_document_store_cutover_monotonic ON document_store_cutover_state;
CREATE TRIGGER trg_document_store_cutover_monotonic
BEFORE UPDATE ON document_store_cutover_state
FOR EACH ROW EXECUTE FUNCTION enforce_document_store_cutover_monotonic();
