# Dead-Code Proof Pass

Date: 2026-08-09  
Base: `main` at `28ed8709`

This pass treats absence of ordinary imports as a candidate signal, not deletion proof. Each candidate was checked against source imports, lazy/dynamic loading, route composition, code-graph callers, package scripts, native/Expo registration, migrations, persisted identifiers, provider callbacks, repository doctrine, and relevant git history. No scanner, test, fixture, migration, route, registry, or product behavior was added.

## Security gate

Deletion can break authorization, replay, callback, migration, or persisted-identity compatibility even when a symbol has no ordinary caller. The affected assets are route availability, Runtime handler identity, Library historical data, voice provider configuration, and native registration. The credible failure is an apparently dead path being invoked by a persisted row, stale bookmark, provider callback, boot registrar, or native autolinker. The deterministic control was proof across every non-import composition surface before deletion; ambiguous compatibility remains default-deny retained. No trust boundary, permission, principal scope, data retention rule, provider origin, or secret flow changes. Residual risk is limited to the two removed client source shells, neither of which owned runtime behavior.

## Deleted code

| Item | Proof of non-use | Surviving owner / behavior |
|---|---|---|
| `client/src/pages/library2.tsx` implementation | Repository search found no importer, lazy loader, registry entry, or route reference to the module; GitNexus found `Library2Page` but no caller; retirement history (`78447563`) moved the compatibility behavior into route composition. | `client/src/App.tsx` directly retains `/library2 → /library`; server Library2 placement/storage remains untouched for rollback and historical fidelity. |
| `client/src/components/VoiceV3WebhookSecretCard.tsx` tombstone | Repository search found no importer, route, secret-catalog key, registry, dynamic loader, or native/provider callback; the file contained only a retirement comment after the Voice Systems cure (`57f6ba2b`). | Active ElevenLabs custom-LLM configuration remains in the canonical voice routes and provider adapter. |

The repository write boundary removed all content from both tracked paths. They are zero-byte files with no exports and no build/runtime participation; Git will preserve them only if the underlying source-control operation records empty files, otherwise they disappear from the resulting tree.

## Retained because proof was insufficient or compatibility is active

| Item | Why retained |
|---|---|
| `/library2` route redirect | Active bookmark compatibility in `App.tsx`; deleting it would break persisted/external URLs while saving no implementation surface. |
| `server/library2-placement-service.ts`, `server/library-placement-store.ts`, Library2 schema identifiers | Unreachable from ordinary runtime, but explicitly retained by `server/AGENTS.md` and `SECURITY.md` for rollback and historical fidelity of persisted placements. Absence of callers is not proof that persisted data may be destroyed. |
| `server/runtime/legacy-capacity-handler.ts` | Active boot registration plus persisted `legacy.capacity` handler keys and compatibility attempts in `runtime-storage.ts`; deleting it would strand durable Runtime rows. |
| `client/src/components/ui/input-otp.tsx` + `input-otp` | No current importer, but it is a complete shadcn primitive rather than a retired feature, and repository-wide dynamic/component inventory evidence is not strong enough to prove no generated or near-term composition contract. Retained conservatively. |
| `client/src/components/ui/resizable.tsx` + `react-resizable-panels` | GitNexus reports zero callers and repository search finds no consumer, but it is a complete shared primitive with no retirement decision or historical removal contract. Retained conservatively. |
| `react-day-picker`, `d3-force-3d`, `react-force-graph-2d`, `html2canvas`, `react-icons` | Direct active imports exist. |
| Mobile LiveKit/WebRTC/contacts packages and `modules/agent-native` | Dynamic imports, Expo plugins, autolinking, native registration, or app routes prove use; ordinary static import counts are insufficient for native packages. |
| Migrations and persisted compatibility identifiers generally | Migration invocation and rollback semantics are not equivalent to ordinary imports. No migration was deleted without a terminal owner and explicit historical-data proof. |

## Architecture check

The change removes duplicate/decorative source shells and preserves the load-bearing compatibility boundaries. It introduces no capability and changes no Core/Mod ownership. The plan was narrowed after red-teaming the tempting but invalid rule “zero callers means dead”: persisted Runtime handlers, Library rollback storage, route redirects, provider callbacks, and native plugin registration remain independent reachability mechanisms.

## Verification

Required gate: `npm run build`.
