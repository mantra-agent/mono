# Persistent Run Divergence

## Failed invariant
The Resources producer treats any instantaneous difference between admitted executor runs and admission slots as drift. Admission and executor registration are separate in-memory observations, so the 2-second poll can catch a valid handoff and falsely warn.

## Plan
1. Add one server-owned divergence classifier shared by the Resources endpoint and system-state projection.
2. Give newly started unmatched runs a 5-second settlement window; only persistent unmatched runs count as drift.
3. Preserve transient evidence neutrally in detail, and identify persistent run IDs plus age for diagnosis.
4. Keep unattributed zombies immediately divergent.
5. Build, review scope, and ship to main.

## Principles
- Single Source of Truth / DRY: one classifier replaces duplicate route/tool logic.
- One Discriminant Per Decision: classifier returns the canonical numeric drift and detail together.
- Fix the producer: UI remains a projection of truthful resource state.
- Product ownership: no capability or Mod ownership change.
- Security: operational metadata only; run IDs are already exposed to system:read operators. No authority, persistence, principal scope, secret, or trust-boundary change.
