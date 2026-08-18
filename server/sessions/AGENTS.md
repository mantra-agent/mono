# Session Tree Architecture

Root `AGENTS.md`, root `CODING.md`, root `SECURITY.md`, and `server/AGENTS.md` are mandatory. This file owns only session-tree constraints.

## Canonical boundaries

- Conversation bodies and lifecycle live in the principal/Vault-scoped chat document through `chat-file-storage.ts`. `document_store_documents` is the durable Session authority.
- `server/sessions/tree.ts` owns the relational `session_tree` projection, spawn serialization, idempotent tuple lookup, and child execution handoff. The chat document mirrors tree metadata for compatibility; it does not independently authorize topology.
- `server/session-tree.ts` owns cross-session scope and chain-depth policy used by the Session tools. Despite the adjacent name, it is policy over caller-supplied principal-visible Session records, not a second persistence store.
- Parent, child, and sibling messaging may target direct relatives only. The tool boundary must load both endpoints through principal-scoped chat storage before topology validation and message append.
- Spawn replay identity is `(parentSessionId, spawnReason, spawnerSkillRun)` when `spawnerSkillRun` exists. `server/sessions/tree.ts` serializes that tuple with the PostgreSQL advisory lock and durable unique projection; process-local `inFlightRuns` is wait optimization only.
- Session status is one discriminant. Current terminal states are `saved` and `failed`; `resolved` is a legacy alias normalized to `saved` at the public Session tool boundary.

## Invariants

- Never mutate Session JSON or `session_tree` with an unscoped raw query.
- Never infer authority from a parent ID, spawn reason, tool text, or title. Principal visibility and direct-relative topology are independent gates.
- Never hold a chat-document or spawn transaction across model/provider execution.
- Never use process-local child promises, EventBus events, or inline parent widgets as durable completion truth.
- Preserve bounded ancestry, child enumeration, and cross-session chain depth.
- Update this file when the actual composition or authority boundary changes.
