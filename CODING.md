# CODING.md — Active Coding Process

This file is the canonical procedural workflow for code changes, debugging, repo/system diagnosis, builds, PRs, merges, deployments, and implementation planning in xyz.

`AGENTS.md` remains canonical for Engineering Principles and repository architecture. Apply those principles while following this process.

## Build & Development

```bash
npm run build    # Full production build (server + client)
```

## Reference Rendering

References are first-class object links, like HTML links for Agent's object graph. Any user-authored, Agent-authored, or system-generated rich text that may mention durable objects should preserve and render canonical references through the shared parser/renderer. Do not strand references as plain text in Chat, Simple, Library, Build, mobile, seeded session messages, notes, descriptions, markdown surfaces, or generated summaries unless the surface is deliberately plain text. Static UI labels like “Discuss” remain ordinary text.

The canonical persisted grammar is `@type:id`. The current shared registry includes `page`, `person`, `goal`, `task`, `project`, `milestone`, `meeting`, `intention`, `decision`, `wellness_activity`, `priority`, `file`, `news`, `web_article`, `x_item`, `reddit_post`, `rss_item`, and `pr`. Do not hard-code a small subset in new code; import/use the shared reference registry, parser, serializer, and renderer so new reference types work everywhere.

The composer supports both `@` and `#` as mention triggers. `#` biases toward work references such as tasks, projects, and goals, but selected mentions still insert canonical `@type:id` text. Do not introduce persisted `#type:id` grammar unless `shared/reference-parser.ts` is deliberately extended and every renderer/storage surface is updated with it.

Legacy forms like `[page:slug]`, `[person:id]`, `[goal:id]`, `[spec:slug]`, and `Intention ID: <id>` are compatibility only, not the target grammar.

Do not create, add, restore, scaffold, maintain, or run tests. No test files, test harnesses, fixtures, snapshots, test runners, or test-only scripts. If a task would normally call for a regression test, do not add one. Never invoke test commands, the `run_tests` tool, Jest/Vitest/Playwright test modes, smoke tests, unit tests, integration tests, end-to-end tests, or ad-hoc test scripts.

Do not run standalone TypeScript checks (`npm run check`, `tsc --noEmit`, or equivalent typecheck-only commands) as part of the normal coding verification loop. The only required automated gate is whether the production build succeeds via `npm run build`. Run typecheck-only commands or tests only if Ray explicitly reverses this policy in the current conversation.

**Do NOT run `npm install`.** `node_modules` is symlinked from the workspace root. Installing will break the symlink. The git clone tool owns this invariant: it hydrates `/app/node_modules` from `/app/package-lock.json` when missing/stale, then points session clones at that shared directory.

## Branch Model

- PRs always target `main`
- Do not report coding work as done until the PR is merged to `main`, unless Ray explicitly asks for PR-only/review-first or merge is blocked
- `live` branch is production — manual publish by a human, never merge directly to `live`
- Branch names use short kebab-case:
  - `feat/<short-description>` for new behavior or product capability
  - `fix/<short-description>` for bug fixes and correctness repairs
  - `chore/<short-description>` for docs, cleanup, or maintenance that does not change product behavior

## Git

- Before any coding work, resolve the target Platform Environment. Do not infer repo, credentials, branch, or host target from memory, workspace files, old session state, or visible repo names. Use the Platforms environment/source/hosting bindings as source of truth when available. Ray's product codebase is Mantra, not xyz; xyz is the agent/app identity. When Ray asks for product/codebase/build workflow work without naming an environment, default to the Platforms registry entry for `Mantra / Web / stage` if it exists and is unambiguous. If multiple Mantra environments are plausible for the requested work, ask Ray before cloning or editing. If no target environment is specified and more than one plausible non-Mantra environment exists, ask Ray for the environment before cloning or editing.
- The workspace `.git` is depth-1 (Railway deploy clone). Use the GitHub API for history, blame, and diffs on the main repo
- Full clones for code work go in `repos/` via the git MCP tool. Each session gets an isolated clone at `repos/{name}-{sessionId[:8]}` (enforced by the tool, not by convention)
- Never guess repository URLs. Use the authenticated workspace remote or an explicit URL from Ray; repo access is credential-bound.
- Shell git is allowed only for read-only inspection: status, log, diff, show, branch list, remote, rev-parse
- Git MCP is the exclusive credentialed path for clone, branch/checkout writes, add, commit, push, PR, merge, and branch deletion

## Coding Task Gate

Before any code diagnosis, system debugging, file edit, build, PR, or merge:

1. Load root `AGENTS.md`.
2. Load this root `CODING.md`.
3. Load the relevant subdirectory `AGENTS.md` for any touched subtree. Relevant means: if you inspect, edit, or rely on files under `client/`, `server/`, `mobile/`, or a nested subtree that has its own `AGENTS.md`, load that subtree's nearest `AGENTS.md` before acting on that code. If a task crosses multiple subtrees, load each applicable file. If the path is unknown, load root `AGENTS.md` and `CODING.md` first, then load subdir instructions as soon as the path becomes known.
4. Check loaded AGENTS.md files for existing patterns that apply to your change before designing.
5. Apply the Engineering Principles in root `AGENTS.md`.
6. Load `DESIGN.md` for UI/product-facing work.
7. Before making changes, write the implementation plan/design and compare it against root `AGENTS.md`, auditing specifically for Engineering Principle violations. Cure architectural violations in the plan before editing.
8. Use Code/GitNexus for architecture and navigation before touching code.
9. Run impact analysis before editing touched symbols, shared modules, data flows, tool contracts, or cross-boundary behavior. For docs-only changes, note that impact is low/no-code rather than forcing symbol analysis to invent relevance.
10. Work in an isolated `repos/` clone. Never modify the workspace root directly.
11. Use shell git only for read-only inspection. Use git MCP for clone, branch, checkout writes, add, commit, push, PR, merge, and branch deletion.
12. Verify with `npm run build`. Do not run tests or standalone TypeScript checks unless Ray explicitly asks.
13. PRs target `main`. Never merge directly to `live`.
14. Do not report coding work as done until the PR is merged to `main`, unless Ray explicitly asks for PR-only/review-first or merge is blocked.
15. Final reports include instructions loaded, files changed, implementation-plan/design check against Engineering Principles, Engineering Principles violations cured in the plan, impact/change-scope evidence, build result, PR reference (canonical `@pr:repo/number`), merge SHA, and any degraded proof.

## Diagnostic Workflow

1. Load root and relevant subdirectory instructions first.
2. Reproduce or inspect the real runtime evidence: logs, persisted state, traces, code graph, or UI state.
3. When the issue involves an external system, library, SDK, hosted API, provider behavior, platform constraint, or integration contract, review the current authoritative API documentation with the `web` tool before drawing conclusions or designing the fix. Do not rely on memory, assumptions, or stale examples when live docs can answer the question.
4. Identify the single source of truth and the invariant that failed.
5. Prefer fixing the producer/state model over patching the renderer/consumer.
6. Use impact analysis before touching symbols or shared flows.

## Standard Coding Ship Path

1. Clone current `main` with git MCP into a session-scoped directory under `repos/`.
2. Create and switch to a branch before edits. Use `feat/<short-kebab-description>`, `fix/<short-kebab-description>`, or `chore/<short-kebab-description>`.
3. Load root `AGENTS.md`.
4. Load root `CODING.md`.
5. Use Code/GitNexus for architecture, navigation, and impact analysis.
6. Load relevant subdirectory `AGENTS.md` files and load `DESIGN.md` for all UI/user-facing work. Relevant subdirectories are every subtree you inspect, edit, or depend on: `client/AGENTS.md` for client/UI code, `server/AGENTS.md` for server code, `mobile/AGENTS.md` for mobile code, and the nearest nested `AGENTS.md` for deeper subsystems.
7. Inspect the existing implementation and identify the smallest coherent change.
8. If the change depends on an external system, library, SDK, hosted API, provider behavior, platform constraint, or integration contract, review the current authoritative API documentation with the `web` tool before finalizing the implementation plan. Capture the relevant contract in the plan instead of guessing from memory.
9. Before making changes, write the implementation plan/design and compare it against root `AGENTS.md`, auditing specifically for Engineering Principle violations. Cure violations in the plan before editing.
10. Make the scoped changes. If the change spreads beyond the planned files, pause and reassess.
11. If you introduced a new reusable pattern, document it concisely in the relevant subdirectory AGENTS.md.
12. Do not add tests, fixtures, or typecheck-only gates.
13. Run `npm run build`. If it fails, fix the build and rerun until it passes.
14. Run change-scope detection before committing when code changed. If tooling is stale or degraded, record that explicitly and use git diff/status as fallback evidence.
15. Review git status and git diff. Stage only intended files.
16. Commit with a concise conventional message.
17. Push the branch with git MCP.
18. Create a PR targeting `main`.
19. When the PR is ready and `npm run build` has passed, merge it to `main` with the repo-standard merge method. Do not leave completed PRs unmerged unless Ray explicitly asks for review first.
20. Do not report coding work as done until the PR is merged to `main`, unless Ray explicitly asks for PR-only/review-first or merge is blocked.
21. Report instructions loaded, plan-vs-AGENTS Engineering Principles check, what Engineering Principles violations were cured in the plan before editing, files changed, impact/change-scope status, build result, PR reference (canonical `@pr:repo/number`), merge SHA, and any degraded checks.

## Implementation Workflow

Follow the Standard Coding Ship Path. Keep changes scoped and coherent. If the change spreads beyond the intended files, pause and reassess.

## Git/PR Workflow

Follow the Standard Coding Ship Path. Use git MCP for all git writes. PRs target `main`. Creating a PR is not completion: after `npm run build` passes and the PR is ready, merge it to `main` unless Ray explicitly asks for review-first/PR-only or merging is blocked. Never merge directly to `live`.

## Verification Workflow

Required automated verification is:

```bash
npm run build
```

If it fails, fix the build. Do not substitute tests, smoke tests, or standalone typechecks for the build gate.

## Final Report Checklist

Final coding reports include:

- Instructions loaded: root AGENTS, root CODING.md, subdir AGENTS, DESIGN if UI.
- Implementation plan/design check against root AGENTS.md Engineering Principles, including what Engineering Principles violations were found and cured in the plan before editing.
- Impact analysis and change-scope status.
- Files changed.
- Build result.
- PR reference using canonical `@pr:repo/number` syntax (e.g., `@pr:xyz/123`), and target branch.
- Merge SHA for the merge to `main`, or the explicit merge blocker / Ray-requested PR-only exception.
- Any degraded or residual enforcement gaps.
