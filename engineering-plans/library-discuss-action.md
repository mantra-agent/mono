# Library Discuss Action — Implementation Plan

## Definition of done

Every live Library page exposes **Discuss** in both its tree-row overflow menu and the active page overflow menu. Choosing it creates a Session titled from the page, seeds one message containing the canonical `@page:<slug>` reference, focuses that Session, and opens the Session Window.

## Design

- **User intention:** discuss the Library page currently in view.
- **Focal object:** one principal-visible Library page.
- **Primary action:** `Discuss` inside the page's existing ellipsis menu.
- **Resulting state:** a focused Session with the page reference in its first message.
- **Hidden depth:** existing Session Window and transcript own the conversation after creation.
- **Existing primitives:** current DropdownMenu presentation, `/api/sessions` creation/message endpoints, `useFocusSession`, React Query session-list invalidation, canonical `@page:<slug>` references.

## Implementation

1. Add one page-specific Discuss mutation at `LibraryTab`, the route owner shared by sidebar rows and the active editor. It creates the Session and first message through the existing canonical APIs, then focuses and opens the Session Window.
2. Thread one `onDiscuss(page)` callback and one pending page ID through `VaultTreeSection` → `DndTree` → `DraggableTreeNode`.
3. Add the same callback/pending contract to `LibraryPageEditor`; render `Discuss` as the first active-page menu item.
4. Use the existing `MessageSquare` / pending `Loader2` menu treatment and canonical `@page:${page.slug}` grammar. Do not create another menu or Session surface.
5. Record the bounded security delta in `SECURITY.md`, build with `npm run build`, review scope, then commit, push, PR, and merge to `main`.

## Engineering Principles audit

- **Single Source of Truth / DRY:** one Library-owned mutation serves both menu surfaces; no duplicated session-creation logic between tree and editor.
- **Canonical Mutation Path:** existing authenticated Session create/message routes remain the only writes.
- **Minimum Viable Protocol:** two existing menus gain one existing action pattern; no new server route, component system, or persisted contract.
- **Interfaces Before Implementation:** explicit page callback and pending-ID props preserve component ownership.
- **Fail Loudly, Degrade Gracefully:** pending state disables repeat activation; mutation errors use the existing toast boundary; no false Session focus occurs before both writes succeed.
- **Every Operation Is Replayable:** UI disables duplicate activation while pending. Existing Session APIs do not expose an idempotency key in this path, matching Home/Simple's current contract; no automatic retry is added.
- **Access Control / Multi-user ownership:** the action originates only from already principal-visible Library page projections. Session and message routes retain their existing authenticated owner-scoped controls. The client sends a canonical reference, never page content.
- **Design:** reuses quiet row-local overflow actions and the existing Session Window; no new CTA color, layout, or surface.

## Security gate

Assets: A02/S2 Library/session data and A03 durable Session state. Flows/boundaries: F02 across B01/B03/B06 using the existing authenticated Session endpoints. Credible threat: a stale or fabricated page identifier could seed a reference to a page the user cannot read, or repeated clicks could create duplicate sessions. Deterministic controls remain the existing principal-scoped Library read and Session write routes plus principal-scoped reference resolution; pending UI state bounds same-surface duplicate clicks. No page body, authority, permission, public route, provider, or logging scope is added. Residual risk: a network retry after the Session is created but before the first message returns can leave an empty owned Session, matching the existing Home/Simple behavior; this change adds no automatic retry.

## Impact and rollback

GitNexus reports low/no discovered upstream impact for `LibraryPageEditor`, `DndTree`, `DraggableTreeNode`, and `SimpleTreeRow`; direct source inspection shows Library-owned call sites only. Expected code scope is `client/src/pages/library/library-tab.tsx`, `library-tree.tsx`, `library-components.tsx`, plus this plan and `SECURITY.md`. Rollback is one PR revert; no schema or data migration is involved.
