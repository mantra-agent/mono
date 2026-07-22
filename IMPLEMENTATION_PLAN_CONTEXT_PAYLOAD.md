# Exact inference payload viewer implementation plan

## Goal

Replace the reconstructed Rendered Prompt/Wire Payload split with one indexed expandable TreeView over a selected, concrete inference request captured at the lowest authoritative observable provider boundary.

## Authority and call-path findings

- `chatCompletion` and `chatCompletionStream` are the tracked text-model roots.
- Direct Anthropic calls dispatch concrete `messages.create` / `messages.stream` parameter objects.
- Direct OpenAI calls dispatch concrete Chat Completions or Responses parameter objects.
- OpenAI subscription calls dispatch a concrete JSON body through `fetch`.
- Claude subscription calls dispatch through `cli-sdk-adapter.ts` into `query({ prompt, options })`. The exact downstream Anthropic request assembled inside Claude Code is not exposed by the Agent SDK.
- Agent SDK documentation states that a custom string system prompt sends only the supplied string, while SDK features such as MCP tools shape behavior outside that string. Mantra disables filesystem setting sources and built-in tools, but the SDK still owns its internal model request and tool-loop envelopes.

## Design

1. Introduce one `inference_payload_captures` table and storage module.
   - User-owned columns: `scope`, `owner_user_id`, `account_id`, `created_by_user_id`.
   - Store the exact secret-free observable request as JSONB, plus boundary/evidence metadata and provider usage.
   - Persist before dispatch so failed and retried attempts remain inspectable.
   - Keep only the newest 20 captures per user/account, deleted in the same transaction as insert.
   - Reads always use `visibleScopePredicate`; captures require an authenticated user principal and never fall back to system ownership.
2. Instrument each active text-provider dispatch producer.
   - Anthropic: exact `params` object before `messages.create/stream`.
   - OpenAI API: exact `params` before Chat Completions/Responses calls.
   - OpenAI subscription: exact body before fetch, excluding authorization headers.
   - Claude Agent SDK: exact prompt, complete safe scalar/list options, full application tool definitions used to create the in-process MCP server, and an explicit residual limitation. Exclude `env`, executable path, callbacks, abort signals, credentials, and opaque SDK server instances.
   - Record one row per real attempt. Retries get separate capture IDs and attempt metadata.
3. Replace Context viewer prompt UI.
   - Remove the `Rendered Prompt`, `Wire Payload`, and old raw-string presentations.
   - Add one `Prompt` Tab with a bounded recent-call selector.
   - Render the selected capture as one indexed tree patterned after the existing Context prompt index/navigation.
   - Every index node expands inline to complete raw JSON for that node. No truncation or summarized substitution.
   - Token/character counts are derived from captured node serialization and remain secondary metadata.
   - Reuse `HierarchyTreeRow` for nested structural connectors and shared collapsible primitives for disclosure.
4. Keep Runtime and Instructions preview controls intact because they inspect current context configuration, but never present them as the captured model request.
5. Add the additive schema to boot convergence and record the new sensitive-data boundary in `SECURITY.md`.
6. Delete PR 959’s in-memory excerpt capture module and superseded shared wire-accounting contracts.

## Engineering Principles audit

- **Single Source of Truth / Canonical Mutation Path:** one persisted capture is produced at the provider dispatch boundary; the viewer does not reconstruct from current context/tool state.
- **Encode Invariants in Structure:** ownership columns are mandatory; bounded retention is enforced transactionally at insert.
- **Replayability / Concurrency:** every attempt is append-only with a generated ID; concurrent inserts cannot overwrite one another; retention runs in the same transaction.
- **Fail loudly, degrade gracefully:** capture failures emit an error but do not block the model request. The UI reports no captures or the precise SDK blind spot rather than fabricating data.
- **Least Privilege / Data minimization:** no credentials, authorization headers, environment, executable paths, signals, or callbacks are persisted. Prompt/model content remains user-owned sensitive data.
- **Progressive disclosure / Shared UI:** one hierarchy tree exposes complete depth on demand using existing primitives.
- **Rollback:** revert the PR. The additive table may remain inert safely.

## Security gate

- Assets: user prompts, system/context prompts, history, tool inputs/results, tool schemas, model-routing metadata.
- Classification: S3 private user/model content.
- Boundary: application provider adapter to external model provider/Agent SDK, then authenticated Context route to browser.
- Abuse case: another user reads a captured prompt, or credentials are persisted inside a captured request.
- Deterministic controls: required current user principal; ownership-scoped insert/read; no system fallback; explicit safe request projection excluding secret-bearing transport fields; bounded retention; authenticated existing Context routes.
- Residual risk: authorized users can inspect their own highly sensitive prompts. Claude Agent SDK internal provider request and injected envelopes remain unobservable below `query()` and are labeled as such.

## Verification

Run only `npm run build`, then change-scope inspection and git diff/status. No tests or standalone typecheck.
