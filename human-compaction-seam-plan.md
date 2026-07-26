# Human Compaction Seam — Implementation Plan

## Definition of done

A compacted session reads as one continuous human conversation. The collapsed seam says how many earlier messages exist. Expanding it fetches the private archive on demand and renders those records through the canonical `MessageList` above a quiet seam labeled “Earlier conversation ends here”; collapsing restores the short row. Machine-facing compaction details leave the primary UI.

## Design protocol

- **User intention:** read earlier conversation.
- **Focal object:** the earlier messages themselves.
- **Primary action:** Show / Hide.
- **Resulting state:** archived records appear in their original transcript treatment above the seam.
- **Hidden depth:** archive retrieval and compaction diagnostics remain infrastructure.
- **Existing primitives:** `MessageList`, `ChatTurn`, React Query, the principal-scoped chat route, and `readVisibleIndexedContent`.

## Smallest coherent implementation

1. Extend `compaction-archive.ts` with one structured reconstruction function that recursively expands nested compaction archives and returns persisted public transcript records. Preserve exact archived records when present; synthesize only minimal user/assistant records for legacy archives.
2. Add an authenticated, no-store transcript projection beside the existing download route. Resolve access from the principal-visible session and marker first, then read every archive through `readVisibleIndexedContent`; never expose object paths or raw archive envelopes.
3. Replace the card-like `CompactionBoundary` with a quiet 44px disclosure seam. Fetch only when opened. Feed returned records into a render callback supplied by `MessageList`, which recursively reuses `MessageList` in historical mode so messages, attachments, tool chronology, system notices, child blocks, references, and formatting keep their canonical presentation.
4. Historical mode suppresses live stream/event projections and empty-state behavior so opening an archive cannot duplicate current session activity. It merges question-response metadata from the archived records so old clarification widgets remain settled.
5. Record the changed private-data projection in `SECURITY.md`.

## Engineering-principle audit

- **Single Source of Truth / Canonical Mutation Path:** archive bytes remain authoritative; the endpoint is a read projection and `MessageList` remains the only transcript renderer.
- **Progressive Disclosure:** archive bytes load only after Show.
- **Minimum Viable Protocol / DRY:** no second archive store, message-card implementation, or client reconstruction parser.
- **Assume No Starting Point:** expansion works from persisted session marker + archive after reconnect/restart.
- **Fail Loudly, Degrade Gracefully:** an unavailable archive leaves the seam visible with a retryable human error; the active conversation remains untouched.
- **Bounded work:** recursive expansion keeps the existing depth/cycle guard. One user action causes one bounded archive-chain read.

### Violations cured before editing

- Rejected parsing archive JSON in the browser: that would duplicate the server archive contract and expose infrastructure shape.
- Rejected a bespoke archived-message renderer inside the seam: that would diverge from normal transcript behavior.
- Rejected returning raw indexed-content/object references: authorization must begin from the visible session + exact marker.
- Rejected injecting archived records into active session state: expanded history is a local read projection, never canonical live state.

## Security gate

- **Assets/data:** A02, S1/S2 conversation history, tool evidence, attachments, and private references.
- **Boundaries/flows:** F02/F06/F07 across B01/B03/B06/B07.
- **Credible abuse case:** a caller guesses a session, marker, or nested archive ID to retrieve another user’s private conversation; a malformed archive attempts unbounded recursive expansion.
- **Controls:** authenticated principal; principal-scoped `chatStorage.getSession/getMessagesBySession`; exact marker ownership relation; `readVisibleIndexedContent` sensitive row scope plus object ACL on every nested read; 32-level/cycle guard; private no-store response; no object path or archive ref in the response.
- **Residual risk:** a very large authorized archive can create a heavy client render after explicit expansion. Retrieval is user-initiated and does not affect model context or canonical session state.

## Verification

Run `npm run build`, then inspect change scope, git diff, and git status. PR targets `main` and merges after the build passes.
