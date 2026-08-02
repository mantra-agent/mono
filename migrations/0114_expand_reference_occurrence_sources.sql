-- Preserve complete authored topology for bounded large source artifacts while
-- keeping individual SQL writes chunked in the canonical storage boundary.
ALTER TABLE reference_occurrence_sources
  DROP CONSTRAINT IF EXISTS reference_occurrence_sources_count_check,
  ADD CONSTRAINT reference_occurrence_sources_count_check
    CHECK (occurrence_count BETWEEN 0 AND 5000);

ALTER TABLE reference_occurrences
  DROP CONSTRAINT IF EXISTS reference_occurrences_ordinal_check,
  ADD CONSTRAINT reference_occurrences_ordinal_check
    CHECK (occurrence_ordinal BETWEEN 0 AND 4999);
