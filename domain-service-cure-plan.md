# Domain Service Cure — Implementation Plan

## Audit partition

- People / relationships: principal-scoped PeopleStorage and replay-safe import/link services are established; no deletion without stronger runtime-registration proof.
- Goals / work / strategy / finance / wellness / Library / Files / meetings / email: retain their current canonical storage boundaries; broad route-local persistence remains follow-on evidence, not a safe one-pass rewrite.
- Notifications / provider integrations: SendGrid, Recall, and Sentry own explicit provider adapters but issue unbounded `fetch` calls and independently read arbitrary provider error bodies. Twilio already names a request ceiling but shares no bounded response-body contract.
- Media: `registerMediaItem` accepts caller-supplied ownership fields and resolves object-path conflicts without principal scope. Render output separately writes bytes and ACL instead of crossing `ObjectStorageService.uploadObjectEntity`, the documented canonical server-side upload boundary.

## Smallest coherent cure

1. Add one dependency-light provider HTTP primitive under `server/integrations/` that composes caller cancellation with a named timeout and reads provider error bodies with an actual byte ceiling.
2. Move SendGrid, Recall, Sentry, and Twilio adapters onto it. Keep each adapter's provider-specific success/error discriminants; do not create a generic provider business abstraction.
3. Make Media registration derive user ownership exclusively from the Principal and scope conflict recovery to rows visible to that Principal. Foreign conflicts fail closed without exposing the row.
4. Route render output bytes + ACL through `ObjectStorageService.uploadObjectEntity`; remove the parallel put-object / ACL sequence.
5. Persist the reusable contracts in `server/AGENTS.md` and add a source-backed SECURITY finding with rollback and residual risk.

## Principle and ownership check

- **Single Source / Canonical Mutation Path:** one transport resource ceiling, one media upload boundary, one media ownership derivation.
- **Modular Systems / Interfaces Before Implementation:** provider transport owns only HTTP mechanics; provider adapters retain business semantics. Media remains the owning domain. No product capability or Mod contribution changes.
- **Every Operation Replayable:** this pass does not blindly retry provider mutations. Existing domain idempotency remains authoritative; timeout outcomes remain ambiguous and fail truthfully. Media conflict recovery is scoped and convergent.
- **Fail Loudly, Degrade Gracefully:** provider timeouts are bounded failures; response evidence is bounded; notification readiness keeps its explicit `not_configured` outcome; render persistence failures remain visible.
- **Least Privilege / Ownership:** Principal-derived Media ownership cannot be caller-overridden; conflict reads cannot disclose another principal's row.

## Security gate

Affected assets: S2/S3 provider request/response data, provider credentials, private Media metadata/bytes, Vault/object ACLs. Boundaries: authenticated/public notification producers → fixed-origin provider adapters; authenticated Media render → private object storage + Media row. Credible abuse/failure: stalled provider sockets exhaust server capacity; oversized provider errors amplify memory/log exposure; forged Media ownership or unscoped conflict lookup discloses a foreign row; split byte/ACL writes create unowned artifacts. Deterministic controls: fixed origins, provider adapter allowlists, deadline signal, capped body reader, exact Principal-derived ownership, visible-scope conflict resolution, canonical compensating object upload. No prompt-based control.

## Verification

Production build only (`npm run build`), then change-scope inspection, PR to `main`, and merge. No tests or standalone typecheck.
