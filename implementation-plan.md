# Resource Thresholds Repair

## Intent
Make the System Resources tree communicate only evidenced risk, and restore the canonical right-aligned metadata edge across inline `ProfileTreeRow` consumers.

## Failed invariants
- Missing capacity or sample evidence is currently classified as amber, so “unknown” masquerades as risk.
- Event-loop lifetime peak can keep the service warning after the active condition has passed.
- Inline tree rows allocate a bounded value track without a flexible spacer, so row metadata ends near the label rather than at the shared right edge.

## Plan
1. Extend the local Resources status discriminant with `unknown`; render it neutrally and exclude it from warning escalation.
2. Classify unavailable memory limits and absent frontend/context/reliability samples as unknown. Use measured capacity pressure thresholds (80% warning, 90% critical), and never treat an absolute RSS value as inherently unhealthy.
3. Base event-loop severity on current/average active lag; retain peak only as disclosed diagnostic evidence.
4. Repair `ProfileTreeRow` inline geometry with a flexible value track and explicit end alignment while preserving the established fixed value width and controls.
5. Audit against DESIGN.md, run the production build, inspect diff, then ship through PR to main.

## Engineering Principles check
- Single Source of Truth / DRY: threshold constants remain centralized in `resources-thresholds.ts`; status rendering remains one local discriminated path.
- One Discriminant Per Decision: add `unknown` to the existing status discriminant rather than inventing special-case flags.
- Fix producer/shared primitive: repair `ProfileTreeRow` rather than patching each Resources row.
- Minimum Viable Protocol: no new component or parallel tree pattern.
- Product ownership: no capability ownership or Mod composition change.
- Security: presentation-only and read-only diagnostic classification; no trust boundary, authority, persistence, secret, or data-scope change. No SECURITY.md finding required.

## Design protocol
User intention: assess. Focal object: resource health. Primary action: disclose a metric. Result: measured risk is colored; unavailable evidence stays neutral. Hidden depth: thresholds and raw values remain in row disclosure. Existing primitives: PerformanceSection + ProfileTreeRow.
