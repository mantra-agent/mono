CREATE TABLE IF NOT EXISTS magic_demo_vision_frames (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES magic_demo_sessions(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'dat_camera',
  object_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  format TEXT NOT NULL,
  capture_mode TEXT NOT NULL DEFAULT 'still',
  linked_utterance_id TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_magic_demo_vision_frames_session_created ON magic_demo_vision_frames(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_magic_demo_vision_frames_utterance ON magic_demo_vision_frames(linked_utterance_id);
