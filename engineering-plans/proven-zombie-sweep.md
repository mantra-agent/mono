# Proven Zombie Sweep

## Scope and design gate

Current `main` after the architecture cures was inspected through repository import/reference search, GitNexus callers/impact, composition roots, route/tool/Mod registries, package scripts, mobile native/plugin registration, migrations, persisted identifiers, provider callback contracts, and git history. This maintenance change adds no capability and changes no Core/Mod ownership.

The smallest proof-preserving cure is to remove only the retired Library2 execution cluster. Ordinary Library filing already terminates at `library-save.ts`; durable `library_placements` schema/rows and move-time compatibility cleanup remain intact for historical fidelity and rollback. The result contract moves beside the live filing boundary rather than keeping a 413-line retired semantic engine alive for one type import.

Engineering Principles check:

- **Single Source of Truth / Canonical Mutation Path:** canonical Library filing remains `createFiledLibraryPage`; no parallel organizer survives.
- **Leave No Zombies:** unreachable semantic placement, compilation, corpus migration, placement service/store, parser, and manual runner implementations are removed.
- **Migrate, Don't Mutate:** persisted placement rows, schema declarations, bootstrap convergence, and move-time compatibility repair remain. No data or migration is deleted.
- **Least Privilege / Security:** deleting unreachable mutation-capable code reduces dormant attack surface. Principal/Vault checks on live Library create/move/trash/link paths are unchanged.
- **Minimum Viable Protocol:** the live filing outcome type contains only outcomes still emitted by standard Library filing.

Security gate: affected assets are A02 private Library pages and A03 Vault/placement metadata across F02/F03/F06 and B03/B06. The credible abuse case is accidental reactivation of dormant model-backed organization or a manual migration entrypoint, causing unauthorized/unwanted hierarchy mutation or resource use. The deterministic control is removal of executable entrypoints while retaining the scoped live Library boundaries and compatibility data. No new trust boundary, authority, provider call, or external input path is introduced. Residual risk is that persisted historical placement rows and schema remain by design; they are inert except for compatibility cleanup during canonical moves.

## Deletion evidence

| Removed implementation | Static/import proof | Composition and dynamic proof | Compatibility/data proof | History context |
|---|---|---|---|---|
| `server/library-placement.ts` semantic engine | Call graph reached only retired corpus migration and Library2 placement service; live `library-save.ts` imported only its result type | No route, tool, Mod, Skill, Workflow, Hook, Timer, boot hook, package script, or provider callback reaches it | Result contract localized to live filing; persisted rows unaffected | Library2 runtime retired in `78447563`; engine was intentionally left dormant |
| `server/library-compiler.ts` | GitNexus reported zero callers; exact repository search found no external import | No registry, route, script, or dynamic import | Existing Wiki/Index/Log pages remain ordinary Library pages | Introduced for Library2 compiler, then runtime retired |
| `server/library-corpus-migration.ts` and `server/scripts/run-library-corpus-migration.ts` | Only caller was the manual runner; runner is absent from package scripts and other composition roots | No route/tool/boot/scheduler registration | No migration SQL or persisted identifier removed; historical rows remain | Prior retirement explicitly forbade corpus migration execution |
| `server/library2-placement-service.ts` | Imported only retired placement/store/parser modules; no external caller | `/api/library2` is absent and client route redirects to `/library` | `library_placements` schema remains for rollback/history | Runtime route was removed in `78447563` |
| `server/library-placement-store.ts` | Called only by retired Library2 service | No ordinary runtime registration | Drizzle schema, bootstrap, managed-table declaration, and canonical move cleanup remain | Store belonged solely to removed organizational lens |
| `server/library-index-format.ts` | Used only inside the removed cluster | No route/tool/script registration | Historical Index page content remains untouched | Parser served retired Index semantics only |

## Retained because proof was insufficient or compatibility remains live

| Retained item | Why retained |
|---|---|
| `library_placements` table/schema/bootstrap and `libraryPlacements` Drizzle model | Persisted historical/rollback state. Canonical cross-Vault moves still clear invalid parent pointers without reading placement as authority. |
| `/library2` client redirect | Durable bookmarks may still use the old route; redirect is active compatibility behavior. |
| Voice `session-state.ts`, `sse-stream.ts`, `handleV25CustomLLM`, and `voice-session-engine.ts` | Current imports, provider configuration identity, persisted voice-session archive, and transcript UI still reach them. |
| Legacy memory tables and `memory_entries` references | Quarantine, archival, migration, and historical compatibility contracts remain active and explicitly documented. |
| Native mobile module/plugin surfaces | Expo autolinking, config plugins, deep links, event listeners, and server callbacks provide dynamic reachability beyond static imports. |
| `opportunity_library_pages` and other legacy physical tables | Absence of ordinary callers does not prove persisted data can be dropped; no terminal migration owner was established in this pass. |
| Package dependencies | Repository import scan alone cannot prove non-use across build-time, dynamic, native, CLI, and provider tooling. No dependency met the stronger removal bar. |

## Verification

Required gate: `npm run build`. No tests, fixtures, scanners, or standalone typecheck are added or run.
