# Exact context viewer repair plan

## Failed invariant

PR 980 persisted provider-bound requests, but the viewer replaced the accepted Context prompt tree with a second bespoke index/content renderer, rendered long JSON into a collapsed-width pane, and treated the SDK's sanitized options object as enough evidence even when warm handles had been initialized with earlier concrete options and MCP schemas. Existing rows also had no explicit complete-versus-legacy discriminant.

## Observable provider boundaries

- Direct Anthropic: the concrete `messages.create` / `messages.stream` params immediately before SDK dispatch. These include the rendered system prompt, ordered messages, and tools actually sent.
- Direct OpenAI: the concrete Chat Completions / Responses params immediately before SDK dispatch. Subscription calls capture the exact secret-free fetch body.
- Claude Agent SDK: `query({ prompt, options })` or the equivalent one-shot warm-handle `.query(prompt)` handoff. Anthropic's current TypeScript SDK contract exposes `systemPrompt`, `tools`, `mcpServers`, permission/options fields, lifecycle hooks, and streamed SDK messages, but no hook exposing the private downstream Anthropic request assembled by Claude Code. Mantra can and must capture its rendered prompt/system text, original ordered messages, concrete MCP tool schemas, and serializable options. Only Claude Code's private downstream harness text and internally generated reminder/tool-loop envelopes remain unobservable.

## Implementation

1. Make `inference-payload-capture.ts` stamp every newly persisted row with one capture-version/completeness discriminant. Existing rows without it project as incomplete legacy captures. Preserve the existing append-only, principal-scoped, newest-20 retention boundary and secret exclusions.
2. Keep direct-provider capture at `model-client.ts`'s canonical dispatch wrapper. The concrete request already contains the exact provider-visible order and resolved per-call tool set.
3. Repair `cli-sdk-adapter.ts` so each capture snapshots:
   - the exact rendered `prompt` and `systemPrompt` supplied to the SDK,
   - the original ordered message/history records used to render them,
   - every exact resolved per-call tool definition as MCP name, description, and full JSON input schema,
   - the complete safe serializable query options,
   - the actual immutable options/tool snapshot owned by a prewarmed worker when dispatch uses that worker rather than a newly constructed query.
4. Replace PR 980's split bespoke index/content renderer with one inline hierarchy using the existing shared `ProfileTreeRow` disclosure styling and `HierarchyTreeRow` connectors. The selected call is the root. Object key and array order come directly from the immutable captured JSON.
5. Give exact-content nodes semantic expansion without consulting live state:
   - parse rendered `<section ...>` strings into ordered section rows whose expansion is the exact bounded section substring including headings, whitespace, lists, and XML boundaries,
   - label each captured tool by its captured name and show the complete captured schema on expansion,
   - label ordered message/tool-call/result records by role/name/index and show their complete captured content and metadata,
   - retain all other fields as expandable raw values.
6. Delete the custom two-pane payload index/content code and show legacy incompleteness explicitly.
7. Update the canonical security finding and server invariant to name capture completeness, warm-handle ownership, and the precise SDK-only blind spot.

## Engineering Principles audit

- **Single Source of Truth:** the persisted dispatch snapshot is the only viewer input. No live context builder or registry lookup is allowed at render time.
- **Canonical Mutation Path:** all rows still cross `captureInferencePayload`; provider adapters only supply their exact boundary projection.
- **DRY / Minimum Viable Protocol:** one shared standard row primitive renders every level. The bespoke parallel index and content trees are removed.
- **Encode Invariants in Structure:** one version/completeness discriminant distinguishes new complete snapshots from legacy rows.
- **Replayability / concurrency:** captures remain append-only. Prewarmed handles carry the immutable initialization snapshot they actually own, preventing current-call state from being mislabeled as the dispatched worker state.
- **Progressive disclosure:** the root call, payload fields, sections, messages, and tools expand inline. Exact text/schema appears only when requested.
- **Least privilege / data minimization:** ownership predicates and newest-20 retention remain. Credentials, auth headers, executable path, environment, callbacks, signals, and opaque runtime objects remain excluded.
- **Fail loudly, degrade gracefully:** capture failure remains visible and non-blocking. Legacy snapshots render an explicit incomplete label instead of fabricated completeness.
- **Rollback:** revert the PR. The additive capture metadata is JSON and requires no destructive migration.

## Security gate

- Assets/data classes: S3 prompt/history/tool payloads, tool schemas, routing metadata, model options.
- Boundary: user-principal model execution to provider/SDK, PostgreSQL capture storage, authenticated Context route back to the same user.
- Abuse case: cross-user payload disclosure; secret persistence; a warm SDK worker being labeled with schemas/options it did not receive; legacy partial data presented as complete.
- Threats: information disclosure, confused-deputy attribution, stale-state substitution, sensitive logging.
- Deterministic controls: required user principal, owner/account predicates, secret allowlist projection, append-only snapshot, per-handle immutable initialization evidence, bounded retention, explicit completeness discriminant.
- Residual risk: an authorized user can inspect their own highly sensitive model context. Claude Code's private downstream request assembly remains unavailable because the SDK exposes no provider-request hook.

## Verification

Run `npm run build` only. After merge and stage deployment, use authenticated desktop verification on `/brain?tab=context`, select a newly captured real call, expand one rendered context section and one captured tool, and retain screenshot plus structured evidence. If the stage route cannot produce or expose a new complete call, leave the task active/needs review and state the exact blocker.
