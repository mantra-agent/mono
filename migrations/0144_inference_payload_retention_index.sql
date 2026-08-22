CREATE INDEX IF NOT EXISTS idx_inference_payload_inline_linked_owner_captured
  ON inference_payload_captures(owner_user_id, account_id, captured_at DESC, id DESC)
  WHERE scope = 'user'
    AND api_call_id IS NOT NULL
    AND request->>'encoding' IS DISTINCT FROM 'private-object-json-utf8-v1';
