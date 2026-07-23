UPDATE document_store_documents
SET metadata = metadata
  || jsonb_build_object(
    'meeting', content::jsonb->'meeting',
    'meetingTranscriptCount', (
      SELECT COUNT(*)::int
      FROM jsonb_array_elements(COALESCE(content::jsonb->'messages', '[]'::jsonb)) AS message
      WHERE message->>'role' = 'user'
        AND message ? 'speaker'
        AND NULLIF(BTRIM(message->>'content'), '') IS NOT NULL
    )
  )
WHERE document_type = 'chat'
  AND COALESCE(content::jsonb->>'type', metadata->>'type') = 'meeting'
  AND content::jsonb ? 'meeting';

UPDATE memory_entries
SET metadata = metadata
  || jsonb_build_object(
    'meeting', content::jsonb->'meeting',
    'meetingTranscriptCount', (
      SELECT COUNT(*)::int
      FROM jsonb_array_elements(COALESCE(content::jsonb->'messages', '[]'::jsonb)) AS message
      WHERE message->>'role' = 'user'
        AND message ? 'speaker'
        AND NULLIF(BTRIM(message->>'content'), '') IS NOT NULL
    )
  )
WHERE layer = 'workspace'
  AND source = 'chat'
  AND COALESCE(content::jsonb->>'type', metadata->>'type') = 'meeting'
  AND content::jsonb ? 'meeting';
