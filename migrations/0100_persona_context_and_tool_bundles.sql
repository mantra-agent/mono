-- Persona becomes the single source of truth for context sections and tool inclusions.
-- Additive and idempotent: existing personas default to an empty bundle, which the
-- assembler treats as the default-included context (no behavior change until seeded).
ALTER TABLE personas ADD COLUMN IF NOT EXISTS context_sections JSONB DEFAULT '{}'::jsonb;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS tool_bundle JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN personas.context_sections IS 'Persona-owned context section bundle (Record<sectionId, boolean>). Single source of truth for which optional context sections load; replaces session-level context flags.';
COMMENT ON COLUMN personas.tool_bundle IS 'Tool names loaded with full schema for this persona beyond the always-on core.';
