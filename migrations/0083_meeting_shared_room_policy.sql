-- Meeting-level shared-room mode replaces attendee-email stream selectors.
-- Runtime readers continue accepting selected_shared_streams during rollout.
UPDATE calendar_event_metadata
SET speaker_policy = '{"mode":"shared_room"}'::jsonb,
    updated_at = CURRENT_TIMESTAMP
WHERE speaker_policy->>'mode' = 'selected_shared_streams';
