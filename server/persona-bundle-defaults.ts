export const PERSONA_BUNDLE_DEFAULTS_VERSION = 1;

const DEFAULT_CONTEXT_SECTIONS: Record<string, boolean> = {
  "memory": true,
  "memory.recent_sessions": true,
  "world_model.people.others": true,
  "world_model.active_work": true,
  "world_model.people.self.principles": true,
  "world_model.people.self.chat_instructions": true,
  "thoughts": true,
  "session_context": true,
};

const PERSONA_CONTEXT_SECTIONS: Record<string, Record<string, boolean>> = {
  Default: DEFAULT_CONTEXT_SECTIONS,
  Companion: {
    "memory": true,
    "memory.recent_sessions": true,
    "world_model.people.others": true,
    "world_model.people.partner.goals": false,
    "world_model.meeting": false,
    "world_model.people.self.principles": true,
    "world_model.people.self.journal": true,
    "world_model.people.self.chat_instructions": true,
    "thoughts": true,
    "session_context": true,
  },
  Coach: {
    "memory": true,
    "memory.recent_sessions": true,
    "world_model.active_work": true,
    "world_model.people.self.principles": true,
    "world_model.people.self.journal": true,
    "world_model.people.self.chat_instructions": true,
    "world_model.meeting": false,
    "thoughts": true,
    "session_context": true,
  },
  Strategist: {
    "memory": true,
    "memory.recent_sessions": true,
    "world_model.people.others": true,
    "world_model.active_work": true,
    "world_model.decisions": true,
    "world_model.people.self.principles": true,
    "world_model.people.self.emotional_guidance": false,
    "world_model.people.self.emotional_expression": false,
    "world_model.meeting": false,
    "thoughts": true,
    "session_context": true,
  },
  Architect: {
    "memory": true,
    "memory.recent_sessions": true,
    "world_model.active_work": true,
    "world_model.decisions": true,
    "world_model.people.self.principles": true,
    "world_model.people.partner.goals": false,
    "world_model.people.self.emotional_guidance": false,
    "world_model.people.self.emotional_expression": false,
    "world_model.meeting": false,
    "thoughts": true,
    "session_context": false,
  },
  Engineer: {
    "memory.recent_sessions": true,
    "world_model.active_work": true,
    "world_model.people.partner.goals": false,
    "world_model.people.self.emotional_guidance": false,
    "world_model.people.self.emotional_state": false,
    "world_model.people.self.emotional_expression": false,
    "world_model.meeting": false,
    "world_model.people.self.chat_instructions": false,
    "world_model.people.self.principles": false,
    "thoughts": false,
    "session_context": false,
  },
  Operator: {
    "world_model.active_work": true,
    "world_model.decisions": true,
    "world_model.people.partner.goals.this_month": false,
    "world_model.people.self.emotional_guidance": false,
    "world_model.people.self.emotional_state": false,
    "world_model.people.self.emotional_expression": false,
    "memory.recent_sessions": false,
    "thoughts": false,
    "session_context": false,
  },
  Creative: {
    "memory": true,
    "memory.recent_sessions": true,
    "world_model.people.partner.goals": false,
    "world_model.people.self.principles": true,
    "world_model.people.self.journal": true,
    "world_model.meeting": false,
    "thoughts": true,
    "session_context": true,
  },
  Investigator: {
    "memory": true,
    "memory.recent_sessions": true,
    "world_model.people.others": true,
    "world_model.active_work": true,
    "capabilities.library": true,
    "world_model.people.partner.goals": false,
    "world_model.people.self.emotional_guidance": false,
    "world_model.people.self.emotional_state": false,
    "world_model.people.self.emotional_expression": false,
    "world_model.meeting": false,
    "world_model.people.self.principles": false,
    "thoughts": false,
    "session_context": true,
  },
  Persuader: {
    "memory": true,
    "memory.recent_sessions": true,
    "world_model.people.others": true,
    "world_model.people.self.principles": true,
    "world_model.people.partner.goals": false,
    "world_model.people.self.emotional_guidance": false,
    "world_model.meeting": true,
    "thoughts": false,
    "session_context": true,
  },
  Router: {
    "world_model.people.self.emotional_guidance": false,
    "world_model.people.self.emotional_state": false,
    "world_model.people.self.emotional_expression": false,
    "world_model.people.self.rules": false,
    "world_model.people.partner": false,
    "world_model.meeting": false,
    "memory.recent_sessions": false,
    "thoughts": false,
    "session_context": false,
  },
};

const PERSONA_TOOL_BUNDLES: Record<string, string[]> = {
  Default: [
    "files", "web", "docx", "phone_call", "companies", "work", "gmail", "meetings",
    "decisions", "exec", "news", "rules", "skills", "finance", "health", "weather",
  ],
  Engineer: [
    "scratch", "files", "shell", "web", "railway", "sentry", "meta", "expo", "code",
    "work", "system", "git", "router", "plan", "workflows", "backup", "indexed_content",
    "platforms",
  ],
  Architect: [
    "scratch", "files", "shell", "web", "railway", "code", "docx", "work", "system",
    "git", "strategy", "decisions", "theses", "router", "plan", "workflows", "skills",
    "images", "indexed_content", "platforms",
  ],
  Operator: [
    "files", "docx", "phone_call", "companies", "work", "system", "hooks", "gmail",
    "meetings", "decisions", "rules", "workflows", "finance", "timers", "health",
  ],
  Creative: [
    "files", "web", "docx", "notion", "twitter", "gmail", "content", "exec",
    "theses", "news", "images", "weather", "indexed_content",
  ],
  Companion: [
    "web", "phone_call", "companies", "gmail", "meetings", "pronunciation", "rules",
    "finance", "health", "weather",
  ],
  Strategist: [
    "files", "web", "docx", "companies", "work", "meetings", "strategy", "decisions",
    "exec", "theses", "news", "plan", "finance", "indexed_content",
  ],
  Coach: [
    "files", "web", "phone_call", "work", "gmail", "meetings", "decisions", "rules",
    "plan", "health", "weather",
  ],
  Investigator: [
    "scratch", "files", "shell", "web", "code", "docx", "companies", "notion",
    "twitter", "gmail", "strategy", "decisions", "exec", "theses", "news", "router",
    "plan", "images", "indexed_content",
  ],
  Persuader: [
    "files", "web", "docx", "phone_call", "companies", "notion", "twitter", "gmail",
    "content", "meetings", "exec", "theses", "news", "rules", "plan", "skills", "images",
    "indexed_content",
  ],
  Router: ["router"],
};

export const CANONICAL_PERSONA_NAMES = Object.freeze(Object.keys(PERSONA_TOOL_BUNDLES));

export function hasPersonaBundleDefaults(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PERSONA_CONTEXT_SECTIONS, name)
    && Object.prototype.hasOwnProperty.call(PERSONA_TOOL_BUNDLES, name);
}

export function contextSectionsForPersona(name: string): Record<string, boolean> {
  return PERSONA_CONTEXT_SECTIONS[name] ?? DEFAULT_CONTEXT_SECTIONS;
}

export function toolBundleForPersona(name: string): string[] {
  return PERSONA_TOOL_BUNDLES[name] ?? PERSONA_TOOL_BUNDLES.Default;
}
