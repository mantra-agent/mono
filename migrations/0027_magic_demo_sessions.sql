CREATE TABLE IF NOT EXISTS magic_demo_sessions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  device_id TEXT,
  app_version TEXT,
  build_number TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_demo_sessions_user_created ON magic_demo_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_magic_demo_sessions_status ON magic_demo_sessions(status);

CREATE TABLE IF NOT EXISTS magic_demo_session_events (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES magic_demo_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_name TEXT NOT NULL,
  route_metadata JSONB,
  dat_state JSONB,
  voice_lifecycle TEXT,
  vision_lifecycle TEXT,
  failure_details JSONB,
  latency_ms INTEGER,
  telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_demo_events_session_created ON magic_demo_session_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_magic_demo_events_type ON magic_demo_session_events(event_type);
