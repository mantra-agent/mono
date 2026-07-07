# Session Tree & Council Architecture

This directory contains the council deliberation system and the broader session tree infrastructure that supports parent-child conversation hierarchies, cross-session messaging, and multi-model adversarial reasoning.

## Session System

Every conversation is a `sessions` row with document-backed message history.

### Session Lifecycle
```
create → active → saved (natural end)
                → resolved (task completed)
                → failed (error/abort)
```

Key files:
- `server/session/session-storage.ts` — CRUD, message append, status transitions
- `server/session/session-manager.ts` — Creation, tree operations, spawn logic

### Session Types
| Type | Description |
|---|---|
| `chat` | User-initiated interactive conversation |
| `autonomous` | System-initiated (timers, hooks, skills) |
| `agent` | Spawned by skills (implement, spec, etc.) or agent-initiated proactive conversation |

### Session Tree

Sessions form a parent-child hierarchy. A session can spawn children, and messages flow between direct relatives only.

```
Root (chat with user)
├── Child A (agent: implement skill)
│   └── Grandchild (sub-task)
├── Child B (agent: research skill)
└── Child C (council deliberation)
    ├── Advocate 1 (advocate)
    └── Advocate 2 (advocate)
```

Key constraints:
- **Messaging scope**: Direct parent ↔ child only. No grandparent, cousin, or cross-tree messaging.
- **Spawn idempotency**: `(parentId, spawnReason)` is unique. Re-spawning with the same reason returns the existing child.
- **Advisory locks**: `pg_advisory_xact_lock(sessionId)` prevents concurrent writes to the same session.

### Cross-Session Messaging

- `server/session/messaging.ts` — `messageParent()`, `messageChild()`, `messageSibling()`
- Messages are appended to both sender and receiver history
- Siblings share the same parent — discovered by `spawnReason` or `sessionId`

### Session Document

Each session stores messages as an ordered array in `sessions.messages` (JSONB):
```jsonc
{ "role": "user|assistant|system|tool",
  "content": "...",
  "toolCalls": [...],   // optional
  "metadata": {...} }   // optional
```

## Council System

Multi-model adversarial deliberation for hard strategic questions.

### Architecture Overview

The council orchestrator fans a question to multiple advocates, each running a different frontier-tier model. Advocates argue positions, critique each other, and converge toward synthesis.

```
Parent session
  → council skill spawns council session
    → spawn advocate-1 (Claude max, advocate skill)
    → spawn advocate-2 (OpenAI max, advocate skill)
    → Round 1: Each advocate produces initial position
    → Round 2+: Each critiques the other, revises own position
    → Convergence check after each round
    → Final synthesis → parent session
```

### Key Files

- `server/council/orchestrator.ts` — `runCouncil()`, round management, convergence logic
- `server/council/advocate.ts` — Single advocate execution, position/critique generation
- `server/council/convergence.ts` — Convergence strategies and detection

### Convergence Strategies

| Strategy | Description |
|---|---|
| `fixed_n` | Run exactly N rounds (default 2), then synthesize |
| `agreement` | Stop when advocates agree on key points |
| `diminishing` | Stop when critique delta falls below threshold |

### Execution Bounds

- Hard cap: 5 rounds maximum (primitive-level, not overridable)
- Council records cumulative cost/token usage for observability only
- Council must not abort due to dollar or token budgets

### Failure Tolerance

- **One-child degradation**: If one advocate fails, the council continues with the surviving advocate's position
- **Both-fail**: Council reports failure to parent session

### Model Assignment

- Advocates are pinned to specific models via `modelOverride` in spawn config
- Default: Advocate 1 = Claude (max tier), Advocate 2 = OpenAI (max tier)
- Set at spawn time, cannot change mid-session

## When Working Here

- **Advisory locks are critical**. Any code that writes to session messages must acquire `pg_advisory_xact_lock`. Missing this causes message interleaving under concurrency.
- **Spawn idempotency** means you can safely call `spawnChild` with the same `spawnReason` multiple times. Use descriptive keys like `advocate-a`.
- **Message ordering matters**. Messages are appended in order. The session document is the source of truth for conversation history.
- **Council usage is observability, not gating**. Cost/token totals may be logged, but council execution must not abort due to dollar or token spend.
- **Model overrides** are immutable per session. To change models, start a new council run.
- **Cross-session messaging validates the tree**. The system checks parent-child or sibling relationships before delivering. Arbitrary cross-tree messages are rejected.
- Cross-reference: Sessions are created by the Autonomous Execution system (see `/server/AGENTS.md` § Autonomous Execution) and consumed by the Skill System (see `/server/AGENTS.md` § Skill System).
