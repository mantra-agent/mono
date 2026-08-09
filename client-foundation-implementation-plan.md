# Client Foundation Cure — Implementation Plan

## Scope and ownership

This is a non-installable Core client-foundation repair. It changes no product capability, Mod contribution surface, installation lifecycle, server permission, or durable mutation contract. Core continues to own the authenticated web shell, route boundaries, shared reference projection, React Query cache, and shared Session transport projection.

## Verified findings

1. **Application failure UI bypasses the design system.** `App.tsx` owns a second class error boundary whose fallback uses inline styles and a raw red hex value, while `route-load-boundary.tsx` already owns tokenized, accessible, logged graceful failure. This violates DRY, semantic tokens, and shared failure ownership.
2. **Client reference resolution is a partial parallel registry.** `shared/references.ts` defines the canonical registered types and routes, but `client/src/components/references/reference-registry.tsx` independently hard-codes a subset. Registered references absent from the client map degrade as “unknown,” even though the shared registry can resolve them. Preserve client-specific labels/icons, but derive fallback reachability from the shared registry.
3. **The app-level BottomBar can create a second live Session subscription.** `SessionActivityProvider` already owns the shared multi-session store and recovery listeners. Uncontrolled BottomBars call `useSessionSubscription` again instead of projecting the provider-owned focused state, duplicating logical subscriptions and browser recovery listeners. Consume the app-level store; keep explicit child-session fallback subscriptions because they cover bounded descendants not guaranteed to be in the provider’s eight-session set.
4. **Shared Issues status icons use raw Tailwind palette colors.** Replace blue/amber literals with semantic active/warning tokens so state survives theme changes and keeps color tied to function.

## Design protocol

- **Intention:** recover.
- **Focal object:** the current application or route.
- **Primary action:** retry/reload.
- **Result:** a fresh render/request without losing unrelated shell state when avoidable.
- **Hidden depth:** structured diagnostics remain in `createLogger`, not in user copy.
- **Existing primitives:** `RouteFailure`, `PageFallback`, `ReferenceRenderer`, shared `REFERENCE_REGISTRY`, `SessionActivityProvider`, semantic status tokens.

The cure does not redesign product pages. Mobile remains normal-flow and full-width; failure actions retain 44px reachability; no extra CTA or competing focus is introduced.

## Security gate

- **Assets/data:** authenticated Session IDs and S2 transcript stream state; canonical object identifiers; browser route/error operational metadata.
- **Boundaries:** authenticated browser → shared `/ws/events` transport → principal-scoped server subscription; untrusted persisted/model-authored reference text → shared parser/registry → client navigation; untrusted render/module failure → bounded client telemetry and recovery UI.
- **Threat/failure:** duplicate logical subscribers amplify private stream delivery and recovery churn inside one authorized browser; a partial client registry strands valid object links and can navigate through stale parallel routes; raw error fallbacks can disclose uncontrolled error text and bypass shared recovery behavior (STRIDE tampering/repudiation/availability and privacy-adjacent over-delivery; DATA-01/OBS-01).
- **Controls/owner:** SessionActivityProvider remains the single app-level stream projection owner; WebSocket/server authorization remains independent and authoritative. Shared `REFERENCE_REGISTRY` supplies fallback routes, while client presentation remains non-authoritative. One Core error boundary emits bounded structured logs and tokenized recovery UI. No content, tokens, credentials, query keys, or reference metadata are added to telemetry.
- **Residual risk:** specialized native meeting, logs, visualizer, render-progress, and glasses transports have distinct protocols and remain intentionally separate. Child Session blocks retain bounded fallback subscriptions when the app-level live set does not include them. Reference labels remain a client presentation map and may be generic for newly registered types, but valid shared types no longer degrade as unknown.

## Engineering-principle check

- **Single Source of Truth / DRY:** derive reference reachability from the shared registry and app-level focused stream state from the app-level store.
- **Modular Systems:** keep transport, projection, references, and failure UI behind their existing boundaries.
- **Minimum Viable Protocol:** no new state store, transport, route system, or component family.
- **Fail Loudly, Degrade Gracefully:** one logged error owner and one accessible recovery surface.
- **Observability:** preserve `createLogger`; no raw console calls.
- **Leave No Zombies:** retain specialized transports and shared primitives where static/dynamic reachability exists; remove only the superseded app-local boundary implementation.

## Verification

1. Audit the changed surfaces against `DESIGN.md` after editing.
2. Inspect repository diff and static imports/change scope.
3. Run only the required production gate: `npm run build`.
4. Commit, push, open a PR to `main`, and merge after the build passes.
