# Context Threshold Ring — Implementation Plan

## Ownership
Core Session Window observability. This does not add a Mod capability or contribution surface; it visualizes authoritative core chat-runtime state.

## Design
- Extend the server-authoritative `StreamingContent` projection with a bounded `contextPressure` snapshot: provider-bound input tokens, model input limit, and compaction threshold.
- Emit that snapshot immediately after each context assembly, including persona-triggered rebuilds, so live turns update without polling.
- In Detail visibility only (`layer === 2`), render one 1.5px SVG ring around the existing Session Window persona control. Arc completion is `provider-bound request tokens / operating input limit`; normal uses CTA blue, crossing the executor's first compaction trigger uses amber, and >=90% uses red. A subtle tick marks the compaction threshold.
- Keep the icon hit target, menu behavior, and layout unchanged.

## Security gate
Assets/data: S1 operational token counts and model-capacity metadata on the authenticated session WebSocket. Boundary: server runtime to the already-authorized session subscriber. Abuse case: cross-session telemetry disclosure. Control owner: existing `SessionManager` session-scoped subscription and authenticated chat route; no new endpoint, persistence, principal, authority, or external input. Payload is numeric, bounded, and contains no prompt content. Residual risk is low.

## Engineering-principle check
- Single writer: context assembly emits; `SessionManager` projects; UI only renders.
- Reuse: existing streaming state and visibility layer, no parallel store or polling API.
- Minimal blast radius: one shared contract, one reducer event, two assembly emissions, one local UI component.
- Honest UI: actual assembled provider-bound tokens and selected model capacity, not transcript estimates.
- Future optionality: telemetry object can gain additional thresholds without changing the ring's ownership.

No principle violation remains in the plan. The tempting but invalid alternative—estimating from rendered messages—was rejected because it creates a second source of truth.