# Agenda Item Discuss Action — Implementation Plan

## Definition of done

Every Session Agenda item exposes a quiet right-side ellipsis menu with **Discuss**. Choosing it creates a focused Session, seeds one message with the complete source agenda plus the selected item and source/current-parent Session references when present, opens the Session Window, and preserves existing row disclosure, compact spacing, status treatment, and current-item highlighting.

## Design

- **User intention:** discuss one agenda item without losing the agenda around it.
- **Focal object:** the selected item inside the current Session Agenda.
- **Primary action:** `Discuss` inside the row-local ellipsis menu.
- **Resulting state:** a new focused Session whose first user message carries the authorized source context.
- **Hidden depth:** the ordinary Session Window and transcript own the new conversation after creation.
- **Existing primitives:** `DropdownMenu`, the Simple/Library row action grammar, `/api/sessions`, `/api/sessions/:id/messages`, `useFocusSession`, React Query session-list invalidation, and existing agenda/session models.

## Implementation

1. Extend the existing Session Window prop path with the current Session title and optional parent Session ID/title already present in the authorized Session projection. Do not fetch another object or create a new server API.
2. Add one Agenda-owned Discuss mutation in `SessionAgendaTree`. It creates the Session, posts a replay-safe first message containing every agenda item's ID/title/description/status/resolution, then focuses and opens the new Session only after both writes succeed.
3. Pass `onDiscuss` and one pending item ID into each `AgendaItemRow`. Render the ellipsis as a sibling of the disclosure trigger so buttons never nest; reserve only the existing compact right control rail and reuse Simple/Library menu classes, icons, pending state, and accessibility labels.
4. Preserve the existing `HierarchyTreeRow`, `HIERARCHY_SESSION_ROW_CLASS`, first-open current-item derivation, status icons, disclosure body, and all-complete section collapse behavior.
5. Record the security delta in `SECURITY.md`, run `npm run build`, inspect change scope and diff, then commit, push, PR, and merge to `main`.

## Engineering Principles audit

- **Single Source of Truth / DRY:** one agenda-owned mutation and one context serializer serve every item row; agenda and Session metadata come from the already-authorized canonical Session projection.
- **Canonical Mutation Path:** existing authenticated Session create/message routes remain the only durable writes. No parallel conversation endpoint or client-owned persistence is introduced.
- **Minimum Viable Protocol:** the existing row gains one established action; no schema, server route, tool, or authority contract changes.
- **Interfaces Before Implementation:** explicit source-session props and item-action props make context ownership and pending state visible in TypeScript.
- **Every Operation Is Replayable:** the first message carries a stable per-created-session `clientTurnId`; the menu disables all agenda Discuss activation while the mutation is pending. The existing create endpoint has no idempotency key, so no automatic retry is introduced.
- **Fail Loudly, Degrade Gracefully:** mutation failure uses the existing destructive toast boundary and never focuses a partially initialized Session.
- **Access Control / Multi-user ownership:** the UI receives agenda/current-parent metadata only through the principal-scoped Session read path. New Session and message writes cross existing authenticated principal-scoped storage. Context contains IDs/titles and agenda text already visible in the current Session; it grants no additional authority.
- **Design:** the menu is row-local, keyboard reachable, icon-labeled, visually quiet, and composed from shared controls. The disclosure trigger remains the row's main interaction and current-item emphasis remains unchanged.

## Security gate

Assets: A01 authenticated Session ownership, A02/S2 private agenda and conversation context, and A03 durable Session state. Flows/boundaries: F02 across B01/B03/B06 through the existing authenticated Session projection and create/message endpoints. Credible threats: a stale or fabricated source Session ID exposing another user's agenda, selected-item context omitting lifecycle truth, repeated activation creating duplicate Sessions, or agenda text being mistaken for deterministic authority (STRIDE information-disclosure/tampering/denial-of-service/elevation analogue; DATA-01/IAM-02/AGENT-03/OBS-01). Controls: no source refetch occurs; only the already principal-visible Session projection is serialized; existing Session writes retain canonical principal scope; the complete agenda and selected item are field-explicit; the message states context rather than granting authority; pending state bounds same-surface duplicate activation; `clientTurnId` makes message replay idempotent. Owner: Session Runtime / Application UI. Severity: medium. SLA: immediate. Residual risk: network failure after Session creation but before message acceptance can leave an empty owned Session because creation itself has no idempotency/transaction contract; no automatic retry is added.

## Impact and rollback

GitNexus reports low impact for `SessionAgendaTree`: one known downstream utility dependency and no discovered upstream process coupling; direct source inspection shows the component is mounted only by `SessionTranscriptSurface`, which is composed by `SessionTranscriptPanel`. Expected code scope is those three client components plus this plan and `SECURITY.md`. No server, schema, provider, permission, or tool changes are required. Rollback is one PR revert with no data migration.
