# Mantra Security Doctrine and Threat Model

**Status:** Canonical security baseline<br>
**Baseline date:** 2026-07-20<br>
**Source reviewed:** `mantra-agent/mono` at `06d9134` plus the July 21 assistant-checkpoint change<br>
**Applies to:** Mantra browser, server, mobile, agent runtime, data stores, integrations, build systems, and hosted environments

This document is the repository source of truth for Mantra's security doctrine, threat model, control baseline, and risk register. `CODING.md` owns the procedural security gate and points here. Library artifacts may surface this document and its current review state, but must not copy it into a second baseline.

Security claims require evidence. A framework mapping, scanner result, prompt instruction, or passing build is never proof that a control works. Every finding must identify an asset, trust boundary, threat, control, owner, severity, cure SLA, evidence, and status.

## 1. Security doctrine

### 1.1 Product security invariant

A user, external party, compromised content source, model, tool, autonomous run, integration, or environment may exercise only the authority explicitly granted to that principal for that operation. It may read, change, disclose, or execute only the minimum data and capability required. Failure must not silently broaden authority.

This expands the repository's multi-user invariant: no user may see, search, load, mutate, or receive in context another user's private data.

### 1.2 Security principles

1. **Default deny and least privilege.** Every route, socket, object, query, tool, secret, provider operation, and background run starts inaccessible. Named principals, permissions, ownership predicates, capability constraints, and narrow egress rules grant the minimum authority.
2. **Deterministic authority around an untrusted model.** Models propose text and typed arguments. Deterministic code owns authentication, authorization, tenant and vault scope, destructive confirmation, idempotency, executable command and destination constraints, resource budgets, and human gates. Prompts can reinforce controls but cannot enforce them.
3. **Defense in depth.** Identity, authorization, ownership, validation, storage policy, runtime isolation, provider policy, logging, and recovery controls overlap. No single prompt, route guard, network perimeter, or provider setting carries the whole invariant.
4. **Data minimization and blast-radius reduction.** Collect, retrieve, place in context, send to providers, log, retain, and expose only what the current operation needs. Separate users, accounts, vaults, environments, credentials, and execution sandboxes.
5. **Secure defaults.** A missing setting, unknown route, unclassified callback, absent principal, invalid signature, stale state, or unavailable policy fails closed. Security-sensitive opt-ins require an explicit owner and expiry.
6. **Observable privileged actions.** Authentication changes, permission decisions, secret access, destructive mutations, tool calls, shell/browser/git execution, provider administration, deployments, risk acceptance, and break-glass use emit bounded, tamper-resistant audit evidence without secret values or unnecessary personal content.
7. **Recoverability.** Security design includes revocation, credential rotation, session invalidation, rollback, data restoration, isolation, and incident response. A control that cannot be recovered safely is incomplete.
8. **Secure by design, not user burden.** Mantra owns safe outcomes and makes the safe path the easy path. Users are not expected to compensate for insecure defaults.
9. **Evidence before severity.** Reconnaissance produces hypotheses. Source, runtime metadata, provider configuration, or controlled verification must confirm the failed invariant before a claim becomes a vulnerability.
10. **No ambient authority.** Long-lived credentials, system principals, root processes, broad provider tokens, inherited environment variables, open egress, and general-purpose execution are hazards even when intended functionality uses them. Scope them to the smallest operation and lifetime.

## 2. Ownership and decision rights

| Role | Accountable scope |
|---|---|
| Security Program Owner | Ray until explicitly delegated. Owns policy, release blocks, risk acceptance, incident declaration, and external assessment decisions. |
| Identity and Data Owner | Authentication, sessions, permissions, principals, tenant/vault ownership, PostgreSQL, object ACLs, encryption, retention, and exports. |
| Agent Runtime Owner | Context assembly, retrieval, model boundaries, tool authority, autonomous runs, memory safety, browser/shell/git execution, and resource budgets. |
| Application and Platform Owner | HTTP, APIs, WebSockets, SSE, webhooks, client rendering, mobile, containers, dependencies, Railway, GitHub, EAS, Cloudflare, and release controls. |
| Integration Owner | Provider-specific authentication, callback verification, replay protection, scopes, data minimization, failure handling, and revocation. |
| Operations Owner | Audit evidence, detection, incident response, backup, restore, rollback, rotation, and recovery exercises. |

A person may hold several roles. A finding may not remain unowned. The Security Program Owner is the temporary owner when no implementation owner is known.

## 3. Assets and data classification

### 3.1 Crown jewels

| ID | Crown jewel | Security property |
|---|---|---|
| A01 | Principal and authority graph: users, accounts, vaults, roles, permissions, sessions, service/system principals | Identity authenticity, tenant isolation, least privilege, revocation |
| A02 | Personal intelligence: conversations, memory, people, email, calendar, finance, health, goals, files, meeting audio/transcripts/recaps, emotional state | Confidentiality, purpose limitation, integrity, deletion |
| A03 | Durable agent state: rules, prompts, skills, timers, hooks, plans, workflows, memories, source links | Integrity, provenance, ownership, replay safety |
| A04 | Execution authority: tools, browser, shell, child processes, git, phone, email/social drafts, provider control planes | Authorization, confinement, confirmation, non-repudiation |
| A05 | Secrets and recovery material: session secret, encryption keys, provider credentials, OAuth tokens, invite/reset tokens, webhook secrets | Confidentiality, rotation, minimal lifetime, no plaintext recovery exposure |
| A06 | Production integrity: source, main/live branches, artifacts, migrations, environment bindings, deployments, mobile builds | Provenance, separation of duties, rollback, environment isolation |
| A07 | Security evidence: privileged audit events, logs, findings, acceptance records, deployment and incident history | Completeness, confidentiality, tamper resistance, retention |
| A08 | Availability and cost envelope: database, model/provider quotas, queues, background work, WebSockets/SSE, object storage | Bounded use, backpressure, graceful degradation, recovery |

### 3.2 Data classes

| Class | Definition | Examples | Required handling |
|---|---|---|---|
| S0 Authority Secret | Enables identity, decryption, code execution, provider administration, or account recovery | Password hashes, session IDs/secrets, encryption keys, OAuth/provider tokens, webhook secrets, invite/reset capabilities, signing keys | Never log or send to a model; encrypt or irreversibly hash at rest as appropriate; tightly scoped access; rotation and revocation path; no client exposure except a deliberately issued one-time capability |
| S1 Highly Sensitive Personal | Intimate or regulated-like personal data with severe harm if exposed | Finance, health, private email, contacts, memory, raw meeting audio/transcript, location, family data | User/account/vault scoped; encrypted in transit and protected at rest; minimize model/provider transfer; explicit retention/deletion; no cross-user context |
| S2 Private Product Data | User-created or shared work that is not intended for the public | Sessions, projects, tasks, Library, recaps, uploaded files, drafts | Owner and intended-recipient authorization; object ACL; bounded links; provenance and deletion |
| S3 Security/Operational | Useful to attackers or sensitive to operations | Logs, stack traces, topology, dependency versions, provider metadata, build output, audit records | Privileged access; redact S0 and unnecessary S1/S2; bounded retention; preserve integrity |
| S4 Public | Deliberately published and safe for unauthenticated access | Landing content, explicit public recap subset, health/version fields designed for disclosure | Validate publication decision; prevent private-context bleed; integrity and abuse controls still apply |

Classification follows the most sensitive element in a payload. Derived summaries, embeddings, logs, screenshots, caches, and model transcripts inherit the source classification unless a documented transformation demonstrably removes the sensitive information.

## 4. Actors and assumed adversaries

| ID | Actor | Trust posture |
|---|---|---|
| P01 | Authenticated user | Trusted only for their explicit authority and owned scope. User input remains untrusted data. |
| P02 | Administrator/operator | Privileged human. Require named permission, audit evidence, and purpose; admin status is not blanket data entitlement. |
| P03 | External recipient or provisional member | May receive an intentionally shared subset only. Has no implied access to the sender's private graph. |
| P04 | Service principal/integration | Machine identity limited to named scopes, operation, user/account binding, and lifetime. |
| P05 | Named system job | Internal principal for one documented job. Never a generic substitute for missing user context. |
| P06 | Model | Probabilistic, fallible, and potentially influenced by hostile context. Never an authority source. |
| P07 | Autonomous agent run | Acts for an originating principal under deterministic budgets and gates. Persistence and time do not expand authority. |
| P08 | Third-party provider | External processor and supply-chain dependency. Responses, callbacks, SDKs, and availability are untrusted at the application boundary. |
| P09 | Retrieved source | Email, web page, file, image, audio, transcript, calendar item, memory, database result, or third-party payload. Always untrusted instructions. |
| P10 | External attacker | Unauthenticated or compromised-account actor seeking disclosure, mutation, execution, fraud, cost exhaustion, or disruption. |
| P11 | Compromised dependency, CI job, provider, or source repository | Can alter code, artifacts, responses, or credentials. Must be constrained by provenance and deployment controls. |
| P12 | Insider or stolen operator session | Possesses legitimate-looking access. Requires least privilege, separation, and auditability. |

## 5. System model

### 5.1 External dependencies

The exact configured set varies by account and environment. Security review must inventory the actual environment rather than assume every supported integration is active.

- **Hosting and release:** Railway, GitHub, EAS/Expo, Cloudflare Pages and R2-compatible object storage.
- **Data:** PostgreSQL, pgvector, object storage, local ephemeral workspace, browser/mobile caches.
- **Models and media:** Anthropic/Claude, OpenAI, ElevenLabs, Recall.ai, speech/media processors.
- **Personal services:** Google/Gmail/Calendar, Plaid, Oura, Notion, X, Meta DAT, Sentry, Twilio and other connector-backed services.
- **Execution dependencies:** Chromium/Playwright, shell and child-process runtime, git, GitNexus, Claude CLI, Node/npm build toolchain, EAS CLI.

Each integration must have a named owner, minimum credential scope, user/account binding, approved data classes, callback contract, timeout/retry/idempotency budget, revocation path, and degraded mode.

### 5.2 Primary data flows

| ID | Flow | Assets | Required controls |
|---|---|---|---|
| F01 | Browser/mobile login or recovery -> Express session -> Principal -> permission and ownership enforcement | A01, A05 | Rate limits, strong password handling, session rotation, secure cookie, expiry/revocation, recovery-token hashing, centralized permission checks |
| F02 | Browser/mobile/WebView -> REST/WebSocket/SSE -> Express -> domain service -> PostgreSQL | A01, A02, A03 | Authenticated transport, message-level authorization, bounded input, tenant/vault predicates, output minimization, backpressure |
| F03 | Session/user intent -> context assembly -> memory/RAG/retrieved content -> model provider | A02, A03, A05 | Principal-scoped retrieval, provenance, untrusted-content marking, minimization, secret exclusion, provider policy, prompt-injection resistance |
| F04 | Model output -> tool schema -> deterministic validation/authorization -> side effect/provider | A01, A04, A05 | Typed arguments, capability allowlist, principal binding, confirmation, idempotency, destination/command constraints, audit |
| F05 | Timer/hook/skill/plan/workflow -> owning principal -> autonomous run -> tools and durable writes | A01, A03, A04, A08 | Persisted owner, `runWithPrincipal`, run budgets, cancellation, replay safety, recursion caps, human gates, visible outcome |
| F06 | Express/domain storage -> PostgreSQL/pgvector/document store | A01, A02, A03 | Owned insert values, visible/writable predicates, encryption, bounded queries, migration safety, backup/restore, no system fallback for missing user context |
| F07 | Upload/generation -> object store -> ACL/signed delivery -> browser/mobile/model | A02, A05 | Type/size validation, malware/content policy, random keys, object ACL, short-lived grants, safe content disposition, deletion |
| F08 | Third-party callback/webhook -> public ingress -> signature/state/freshness/replay check -> user/account routing -> idempotent processing | A01, A02, A04, A08 | Raw-body verification, constant-time comparison, timestamp window, replay ledger, owner binding, bounded payload and work |
| F09 | Native mobile -> WebView/API/native bridge/deep link/local storage -> server | A01, A02, A05 | MASVS storage/auth/network/platform/privacy controls, origin/navigation allowlist, bridge minimization, secure key storage, transport security |
| F10 | Developer/agent -> GitHub main -> build artifact -> Railway/EAS/Cloudflare -> stage/live | A05, A06 | Protected source, reviewed change, pinned lockfile, secret isolation, artifact provenance, environment binding, rollback, no direct live mutation |
| F11 | Browser/shell/git execution -> network/filesystem/provider credentials -> result/model/user | A04, A05, A06 | Isolated workspace, non-root runtime where possible, command and egress policy, credential brokering, time/output caps, cleanup, audit |
| F12 | Application/runtime -> logs/telemetry/audit -> dashboard/operator | A02, A05, A07 | Authentication and permission, structured redaction, bounded payload, tenant visibility, retention, integrity, no unauthenticated stream |

### 5.3 Trust boundaries

| ID | Boundary | Untrusted side -> trusted side | Principal/authority decision | Primary threats |
|---|---|---|---|---|
| B01 | Browser network boundary | Browser and public internet -> Express | Session/bearer resolution and route policy | Spoofing, CSRF, XSS, request smuggling, resource exhaustion |
| B02 | Mobile/WebView boundary | Native app, WebView, deep links, device storage -> API/native bridge | User session, device capability, origin and navigation policy | Token theft, bridge abuse, malicious navigation, local disclosure |
| B03 | API composition boundary | HTTP request -> registered route/domain service | Explicit public/personal/admin/service classification plus named permission | Broken object/function authorization, mass assignment, unclassified routes |
| B04 | WebSocket boundary | Upgrade/message -> `/ws`, `/ws/events`, Twilio/Recall/visualizer sockets | Upgrade identity plus per-message/session authorization | Unauthenticated subscriptions, cross-session data, replay, flooding |
| B05 | SSE/voice streaming boundary | Long-lived client/provider stream -> voice/session executor | Provider/user identity, session ownership, stream affinity | Session confusion, data leakage, stale stream injection, DoS |
| B06 | Persistence boundary | Service query/write -> PostgreSQL/pgvector/document store | Principal-aware visible/writable scope and owned insert | Cross-tenant reads/writes, orphaned records, injection, integrity loss |
| B07 | Object boundary | Application/user/model -> object store and delivery URL | Object owner/ACL and bounded grant | IDOR, public objects, content confusion, signed URL leakage |
| B08 | Model-provider boundary | Minimized context -> model -> untrusted output | No authority transfer; provider/data policy | Sensitive disclosure, provider retention, supply chain, misinformation |
| B09 | Retrieval boundary | Email/web/file/media/memory/provider content -> context | Provenance and owning principal; content is data, not policy | Direct/indirect prompt injection, memory/RAG poisoning |
| B10 | Tool boundary | Model-proposed tool call -> deterministic executor | Originating principal, tool capability, schema, confirmation | Excessive agency, confused deputy, unsafe output handling |
| B11 | Autonomy boundary | Scheduler/hook/skill/plan -> background execution | Persisted owner restored as principal; named system jobs only | Principal loss, runaway loops, replay, repudiation |
| B12 | General execution boundary | Tool/agent -> browser/shell/process/git/network | Sandbox, allowlist, brokered credentials, budgets | RCE, secret exfiltration, lateral movement, artifact tampering |
| B13 | Public callback boundary | Provider/attacker -> webhook/OAuth/callback | Signature or OAuth state, freshness, replay, account binding | Forgery, replay, account-link confusion, resource abuse |
| B14 | Provider control-plane boundary | Application/operator -> Railway/GitHub/EAS/Cloudflare/model providers | Named provider connection and least-scoped permission | Environment crossover, deployment tampering, secret compromise |
| B15 | Build and artifact boundary | Repository/dependency -> container/mobile/web artifact | Lockfile, review, scanner evidence, provenance, promotion policy | Malicious dependency, build-script execution, artifact substitution |
| B16 | Observability boundary | Runtime and clients -> logs/events/dashboard | Redaction, permission, visibility, retention | Secret/PII disclosure, log injection, repudiation, unauthenticated monitoring |
| B17 | Recovery boundary | Backup/rotation/rollback operator -> restored system | Explicit break-glass permission and audit | Destructive restore, stale secret recovery, cross-environment contamination |

## 6. Threat analysis

### 6.1 STRIDE view

| STRIDE | Mantra-specific threat | Likely assets/boundaries | Required control families |
|---|---|---|---|
| Spoofing | Stolen 30-day session, forged webhook, replayed OAuth callback, service principal impersonation, cross-session socket subscription | A01, A05; B01, B04, B13 | IAM, callback verification, session rotation/revocation, message-level ownership |
| Tampering | Object ID mutation, mass assignment, memory poisoning, hostile retrieved instructions, plan/hook modification, artifact substitution | A02, A03, A06; B03, B06, B09, B15 | Authorization, immutable provenance, typed patch contracts, signed artifacts, review |
| Repudiation | Privileged action occurs without principal, purpose, decision, or durable audit evidence | A04, A07; B10, B11, B14, B17 | Named principals, structured audit, idempotency keys, correlated run/deployment IDs |
| Information disclosure | Cross-user query, private context in recap, model/provider over-sharing, logs over unauthenticated `/ws`, object URL leakage, mobile local storage exposure | A02, A05, A07; B02, B04, B06-B09, B16 | Scoped storage, minimization, ACLs, redaction, secure mobile storage, provider controls |
| Denial of service | Login brute force, 50 MB request amplification, WebSocket/SSE flood, model/tool loop, webhook replay, expensive browser/shell work | A08; B01, B04, B05, B08, B11-B13 | Per-principal/IP budgets, body limits, concurrency/backpressure, recursion caps, circuit breakers |
| Elevation of privilege | Missing route guard, service principal accepted as personal user, system-principal fallback, prompt-induced shell/git/provider action, root-container breakout | A01, A04-A06; B03, B06, B10-B12, B14 | Default deny, named permissions, no fallback, sandbox, capability broker, non-root runtime |

### 6.2 Credible abuse cases

1. An unauthenticated internet client opens the dashboard log socket and receives runtime logs, then uses disclosed topology or personal content to guide a second attack.
2. An attacker creates accounts through an unintended open registration path and consumes model, browser, email, or provider resources at Mantra's cost.
3. A stolen or fixed session remains useful for weeks because authentication does not rotate or centrally revoke the session.
4. A database reader uses plaintext reset capabilities to take over accounts without cracking password hashes.
5. A malicious email, web page, attachment, calendar event, meeting transcript, or memory tells the model to reveal secrets or call a privileged tool. The model follows it unless deterministic boundaries reject the action.
6. Poisoned durable memory or a compromised source reference silently changes future autonomous behavior across sessions.
7. A tool accepts an object ID that belongs to another account because authorization was checked only at the route or prompt level.
8. A webhook is forged or replayed to trigger duplicate syncs, phone/media actions, state transitions, or unbounded work.
9. A user-controlled URL causes server-side fetching of internal hosts, metadata services, signed URLs, or private provider endpoints.
10. Rich text, Markdown, HTML, SVG, filename, or provider output is rendered or executed without output-context handling, causing script execution or unsafe links.
11. A public recap, invite, export, signed object URL, or provisional identity exposes more of the sender's graph than intentionally shared.
12. A compromised model output reaches shell, browser, git, GitHub, Railway, EAS, or Cloudflare with ambient credentials and changes code or infrastructure.
13. A dependency install/build script or compromised GitHub action changes the artifact even though source review looked safe.
14. Stage credentials, databases, callbacks, or hosting bindings are confused with live and mutate the wrong environment.
15. A root runtime containing git, Chromium, Python, CLIs, full development dependencies, and provider credentials turns one server execution flaw into broad lateral movement.
16. A mobile deep link or WebView navigation loads an untrusted origin that receives session state or invokes an over-broad native bridge.
17. A long-running autonomous plan recursively spawns work or expensive provider calls after the user expected it to stop.
18. Sensitive API responses are copied into general logs under field names the fixed redaction list does not recognize.

## 7. Mandatory control baseline

Control IDs are stable references for findings. Later audits should map framework requirements to these controls rather than create parallel policy documents.

### GOV: Governance and risk

- **GOV-01 Asset and boundary mapping.** Security-sensitive changes update the affected asset, flow, boundary, threat, and control references here.
- **GOV-02 Finding contract.** Findings use the schema in Section 9 and are deduplicated by failed invariant plus enforcement boundary.
- **GOV-03 Risk ownership.** Every open risk has one accountable owner, SLA, next action, and evidence link.
- **GOV-04 Risk acceptance.** Acceptance follows Section 10 and expires automatically.
- **GOV-05 Supplier inventory.** Providers and packages have purpose, data classes, scopes, owner, revocation, and failure mode.

### IAM: Identity and authorization

- **IAM-01 Default-deny ingress.** Unknown or unclassified API and socket paths fail closed. Public endpoints are explicit and minimal.
- **IAM-02 Central principal.** Every request and async operation has an explicit user, narrowly scoped service, or named system principal. Missing context is an error for user-owned data.
- **IAM-03 Named permission.** Privileged functions use the central permission vocabulary and object ownership. Role flags and prompt instructions are not authority.
- **IAM-04 Session safety.** Rotate on authentication and privilege change; use secure, HttpOnly, appropriately same-site cookies; bound absolute and idle lifetime; revoke on logout, credential change, compromise, and account deletion.
- **IAM-05 Recovery safety.** Invite/reset capabilities are random, one-time, short-lived, irreversibly hashed at rest, purpose-bound, and invalidate relevant sessions after password reset.
- **IAM-06 Abuse resistance.** Login, registration, recovery, callback, expensive API, WebSocket/SSE, and provider-funded flows have principal/IP/device budgets and visible throttling.

### DATA: Data and privacy

- **DATA-01 Ownership by construction.** User-owned tables/objects encode owner, account, vault, and scope. Reads/writes use canonical visible/writable/insert helpers.
- **DATA-02 Minimal disclosure.** API responses, contexts, recaps, exports, logs, and provider requests contain only necessary fields and intended recipients.
- **DATA-03 Secret handling.** S0 data never enters logs, model context, client diagnostics, URLs, or general object storage. Encryption and hashing match the threat.
- **DATA-04 Object safety.** Uploads are bounded and treated as hostile; object ACLs and delivery grants are owner-aware, short-lived, and non-enumerable.
- **DATA-05 Retention and deletion.** Each S0-S3 store has retention, deletion, export, backup, and restoration behavior. Derived copies are included.
- **DATA-06 Environment separation.** Stage/live databases, buckets, secrets, callbacks, provider apps, and bindings are distinct unless an approved migration explicitly bridges them.

### ING: Interface and input safety

- **ING-01 Boundary validation.** Parse with strict schemas, reject unknown dangerous fields, normalize once, cap depth/count/bytes/time, and handle output for its destination.
- **ING-02 HTTP baseline.** Apply coherent CSP, HSTS where valid, frame, content-type, referrer, permissions, cache, CORS, and CSRF policy at the composition root.
- **ING-03 Realtime safety.** Authenticate upgrades, authorize every subscription/action, cap messages/queues/connections, enforce backpressure, and clean up on disconnect.
- **ING-04 Callback safety.** Verify raw-body signature or OAuth state, freshness, replay, expected event/schema, owner/account mapping, and idempotency before work.
- **ING-05 Egress and SSRF.** Validate scheme/host/port, resolve and reject private/reserved destinations, constrain redirects and response size/time, and isolate risky fetching.

### AGENT: Model and autonomous authority

- **AGENT-01 Model distrust.** Model output and generated code are untrusted. No model statement grants authority or marks content safe.
- **AGENT-02 Retrieval provenance.** Retrieved data retains source, owner, freshness, trust level, and content/instruction separation. Durable writes preserve provenance.
- **AGENT-03 Capability-bound tools.** Tool schemas are narrow. Deterministic code checks principal, scope, object ownership, destinations, destructive confirmation, and idempotency.
- **AGENT-04 Autonomous budgets.** Runs have persisted owner, objective, time/token/cost/tool/spawn/concurrency limits, cancellation, and a truthful terminal state.
- **AGENT-05 Memory integrity.** Durable memory writes require owner scope, source linkage, bounded influence, contradiction/supersession handling, and protection from instruction promotion.
- **AGENT-06 Output handling.** Model/provider output is validated before rendering, querying, executing, storing, linking, or passing to another interpreter.

### EXEC: General execution

- **EXEC-01 Isolated execution.** Browser, shell, process, git, build, and generated-code execution use a task-scoped workspace/container, minimum filesystem access, and non-root identity where feasible.
- **EXEC-02 Brokered credentials.** Execution receives short-lived, destination-scoped credentials rather than ambient environment secrets.
- **EXEC-03 Command/network constraints.** Structured operations are preferred over arbitrary strings. Commands, paths, URLs, protocols, redirects, output, duration, and child processes are bounded.
- **EXEC-04 Privileged audit.** Execution records principal, run, approved capability, target, sanitized command/operation, result, duration, and artifact provenance.

### SUP: Supply chain and infrastructure

- **SUP-01 Reproducible source.** Lockfiles are authoritative; dependency changes are reviewed; advisories and provenance are inspected; install/build scripts are treated as code execution.
- **SUP-02 Protected release.** Main/live protections, provider permissions, environment bindings, artifact identity, migration compatibility, and rollback are explicit.
- **SUP-03 Runtime minimization.** Runtime image contains only necessary code/tools, runs non-root where feasible, exposes minimum network/filesystem capability, and separates user serving from high-risk execution.
- **SUP-04 Secret separation.** Provider and environment credentials are least-scoped, encrypted, rotated, and unavailable to unrelated builds, logs, models, and subprocesses.

### MOB: Mobile

- **MOB-01 Secure local state.** Sensitive tokens/data use platform secure storage; caches, screenshots, logs, backups, and clipboard exposure are minimized.
- **MOB-02 Auth and network.** Server authorization remains authoritative; transport is secure; session and certificate failures fail closed.
- **MOB-03 Platform boundary.** WebView origins/navigation, deep links, universal links, native bridges, permissions, entitlements, and inter-process communication are allowlisted and minimized.
- **MOB-04 Privacy.** Collection and SDK behavior are transparent, minimal, user-controllable, and consistent with store disclosures.

### OBS/REC: Detection and recovery

- **OBS-01 Security audit.** Privileged and denied actions emit structured, correlated evidence with principal and target, excluding S0 and unnecessary S1/S2.
- **OBS-02 Detection.** Monitor auth abuse, authorization denials, signature failures, unusual provider cost, cross-scope attempts, secret/decryption failures, and execution anomalies.
- **REC-01 Response.** Critical paths have containment, rotation, notification, evidence preservation, and owner escalation procedures.
- **REC-02 Recovery.** Backups, session revocation, secret rotation, deployment rollback, environment isolation, and restored ownership are operationally possible and periodically reviewed.

## 8. Framework crosswalk

These sources calibrate the baseline. Their official control identifiers should be cited in findings when useful.

| Source | Mantra use |
|---|---|
| [NIST Cybersecurity Framework 2.0, CSWP 29](https://doi.org/10.6028/NIST.CSWP.29) | Program outcomes across Govern, Identify, Protect, Detect, Respond, and Recover. This document supplies the Govern/Identify baseline and control ownership; audits and operations must close the remaining outcomes. |
| [NIST Secure Software Development Framework 1.1, SP 800-218](https://doi.org/10.6028/NIST.SP.800-218) | Prepare the Organization, Protect the Software, Produce Well-Secured Software, and Respond to Vulnerabilities. Used for source, build, review, provenance, vulnerability response, and supplier practice. |
| [CISA Secure by Design](https://www.cisa.gov/resources-tools/resources/secure-by-design) | Mantra owns customer security outcomes, uses secure defaults, and practices transparent, accountable remediation. |
| [OWASP ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) | Primary verification catalog for web/API architecture, validation, authentication, sessions, authorization, cryptography, communications, configuration, data protection, logging, files, and business logic. |
| [OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) | API1 object authorization, API2 authentication, API3 property authorization, API4 resource consumption, API5 function authorization, API6 sensitive flows, API7 SSRF, API8 misconfiguration, API9 inventory, API10 unsafe third-party consumption. |
| [OWASP MASVS 2.1](https://mas.owasp.org/news/2024/01/18/masvs-v210-release--masvs-privacy/) and [MASVS controls](https://mas.owasp.org/MASVS/) | Mobile storage, cryptography, authentication, network, platform, code, resilience, and privacy coverage. |
| [OWASP Top 10 for LLM Applications 2025](https://owasp.org/www-project-top-10-for-large-language-model-applications/assets/PDF/OWASP-Top-10-for-LLMs-v2025.pdf) | Prompt injection, sensitive disclosure, supply chain, data/model poisoning, improper output handling, excessive agency, system prompt leakage, vector/embedding weaknesses, misinformation, and unbounded consumption. |
| [OWASP Agentic AI Threats and Mitigations](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/) | Threat-model-based treatment of goal hijacking, tool misuse, identity/privilege abuse, memory/context poisoning, cascading behavior, and control of autonomous action. |
| [OWASP SAMM 2.0.3](https://owasp.org/www-project-samm/) and [SAMM model](https://owaspsamm.org/model/) | Program maturity across Governance, Design, Implementation, Verification, and Operations. Used to measure whether the doctrine becomes repeatable practice. |

## 9. Finding contract and lifecycle

Every finding uses this minimum schema:

```yaml
id: SEC-YYYY-NNN
status: hypothesis | confirmed | false_positive | accepted | cure_in_progress | closed
confidence: low | moderate | high
asset: A##
boundary: B##
flow: F##
threat: specific failed invariant and abuse case
control: one or more stable control IDs
framework_refs: exact framework/control references when known
evidence: source paths/lines, runtime metadata, provider config, or approved verification artifact
preconditions: attacker access and state required
blast_radius: users, data classes, environments, providers, and cost/availability impact
severity: critical | high | medium | low
owner: one role from Section 2
opened_at: ISO date
sla_due: ISO date derived from Section 10
next_action: one falsifiable verification or cure action
acceptance: null or acceptance record from Section 10
closure_evidence: null until the canonical control and ordinary verification prove cure
```

Lifecycle rules:

1. Reconnaissance begins as `hypothesis`. Severity may be provisional but must not be described as a proven vulnerability.
2. `confirmed` requires evidence that the invariant fails on a reachable path. Code presence alone can confirm a design/control gap; exploitability claims need path and precondition evidence.
3. `false_positive` records why the hypothesized path is unreachable or controlled.
4. `closed` requires cure at the canonical enforcement boundary, impact review, `npm run build`, and relevant non-destructive evidence. A prompt-only instruction cannot close a deterministic-control finding.
5. Duplicate symptoms attach as evidence to the same failed invariant. Do not create one finding per route when one composition-root cure applies.
6. Secret values, raw tokens, sensitive payloads, and exploit material never enter the register.

## 10. Severity, cure SLAs, and risk acceptance

### 10.1 Severity and SLA

The highest credible impact controls severity. Likelihood changes priority within a severity but does not erase catastrophic blast radius.

| Severity | Definition | Required response | Cure SLA after confirmation |
|---|---|---|---|
| Critical | Credible path to cross-user S1/S2 disclosure or mutation, account/admin takeover, S0 compromise, arbitrary privileged execution, live supply-chain compromise, irreversible loss, or broad outage with low practical resistance | Notify Security Program Owner immediately; block release; contain/disable within 4 hours; preserve evidence; rotate/revoke as needed | 24 hours, or remain disabled |
| High | Significant user/account compromise, durable agent authority bypass, public sensitive operational exposure, major provider/cost abuse, or a systemic control gap with plausible exploitation | Owner assigned immediately; block affected trust-boundary release; compensating control within 1 day | 3 calendar days |
| Medium | Bounded disclosure/mutation/abuse requiring meaningful preconditions, missing defense in depth, or incomplete audit/recovery that materially weakens response | Track in current security milestone; add temporary detection when useful | 14 calendar days |
| Low | Limited impact hardening, hygiene, or low-probability weakness with narrow blast radius | Track and batch without obscuring higher risks | 45 calendar days |

Hypothesis triage deadlines are 4 hours for provisional Critical, 1 business day for High, 5 business days for Medium, and the next scheduled review for Low.

### 10.2 Risk acceptance

Only the Security Program Owner may accept risk. Acceptance is a time-bounded decision, not a status shortcut.

An acceptance record must state: finding ID; exact failed invariant; business reason; affected assets/data/users/environments; attacker preconditions; worst credible impact; compensating controls and detection; accountable owner; acceptance start and expiry; cure or removal plan; and rollback/containment trigger.

- **Critical:** no normal acceptance. Emergency operation may continue for at most 24 hours only when shutting down causes greater immediate harm, with exposure disabled wherever possible and continuous owner oversight.
- **High:** maximum 14 days. Requires a compensating control, release constraint, detection, and dated cure plan.
- **Medium:** maximum 90 days.
- **Low:** maximum 180 days.
- Acceptance cannot waive tenant isolation, knowingly expose S0, permit unbounded model authority, make active exploitation lawful, or transfer responsibility to users.
- Expired acceptance returns automatically to `confirmed` and blocks the affected release under its severity.

## 11. Verified reconnaissance and initial risk register

The following entries were verified from source and stage environment metadata on 2026-07-20. They are control-gap evidence, not claims that every possible exploit path has been demonstrated. Secret values were not inspected.

| ID | Status / confidence | Asset / boundary / flow | Threat and evidence | Control / owner | Severity / SLA | Next action |
|---|---|---|---|---|---|---|
| SEC-2026-001 | Confirmed control gap, high | A01/A04; B03; F01/F02/F04 | API policy defaults to report-only unless `API_POLICY_ENFORCEMENT=enforce` (`server/api-policy.ts`). Stage variable names do not include that setting. Unknown and unsatisfied routes are logged but not denied. The policy also treats broad service/system principals as satisfying personal routes, so enforcement needs permission-aware design rather than a switch flip. No specific unguarded data route is claimed yet. | IAM-01/02/03, ING-01; Application and Platform Owner | High; 2026-07-23 | Inventory all routes, sockets, and route-local guards; design fail-closed policy with explicit public/service contracts; cure at the composition root without breaking signed callbacks. |
| SEC-2026-002 | Confirmed control gap, high | A01/A08; B01/B03; F01/F02 | Global HTTP baseline is sparse. Source shows conditional `frame-ancestors` CSP only, a 50 MB global JSON limit, and local telemetry budgets. No global Helmet-equivalent header policy or broad auth/API abuse limiter was found. This creates brute-force, resource-consumption, and misconfiguration exposure; exact route exploitability remains to be audited. | IAM-06, ING-01/02; Application and Platform Owner | High; 2026-07-23 | Build an endpoint inventory and abuse budgets, then add composition-root headers, narrower body limits, and route-class-aware throttling with proxy-safe client identity. |
| SEC-2026-003 | Hypothesis, high | A01/A04/A08; B13; F08 | Public callback surface includes Recall, GitHub, Plaid, Oura, Twilio, ElevenLabs/voice, OAuth callbacks, and health callbacks. Recall, Plaid, and Oura contain verification code, but freshness, replay, account binding, and all other callbacks have not yet been uniformly proven. | ING-04, IAM-02/06; Integration Owner | High triage; 2026-07-21 | Enumerate every callback and prove signature/state, freshness, replay ledger, owner binding, idempotency, payload limits, and failure behavior from current provider contracts. |
| SEC-2026-004 | Confirmed reachable exposure, high | A02/A05/A07; B04/B16; F12 | `server/routes.ts` upgrades `/ws` directly with no principal resolution, then broadcasts executor and application logs to every connected socket. REST log routes require `system:read`, but the dashboard log socket bypasses that boundary. Logs are partially redacted, not guaranteed free of S1-S3. | IAM-01/03, ING-03, OBS-01; Application and Platform Owner | High; 2026-07-23 | Require authenticated user plus `system:read` before upgrade, bind the principal to the socket, apply origin/connection budgets, and minimize/redact the stream. Consider temporary disablement before cure. |
| SEC-2026-005 | Confirmed behavior, high confidence; product-policy hypothesis | A01/A08; B01/B03; F01 | `/api/auth/setup` is public until any user exists. `/api/auth/register` accepts an optional invite and creates a user when none is supplied. Setup has a first-user race during empty bootstrap. If membership is intended to be invite-only, registration is an authorization failure; even if open, abuse and provider-cost controls are not evident. | IAM-01/05/06; Identity and Data Owner | High triage; 2026-07-21 | Decide and encode the membership policy. Make bootstrap atomic and environment-controlled; require invite or an explicit public-registration mode; apply rate/cost controls. |
| SEC-2026-006 | Confirmed control gap, high | A01/A05; B01; F01 | Session cookie lifetime is 30 days, `HttpOnly`, `Secure` in production, and `SameSite=None` in production. Authentication sets `userId` on the existing session and saves it; no session regeneration was found in the auth path. Central absolute/idle revocation behavior and CSRF posture require proof. | IAM-04/06, ING-02; Identity and Data Owner | High; 2026-07-23 | Rotate session IDs on login/setup/register and privilege change; define idle/absolute expiry, CSRF strategy, device/session inventory, and revocation on password/reset/logout/account events. |
| SEC-2026-007 | Confirmed control gap, high | A01/A05; B06; F01/F06 | Invite and reset capabilities are generated with strong randomness but stored and queried as plaintext `users.invite_token` and `users.reset_token`. A database read therefore yields live recovery capability. Reset completion does not visibly revoke existing sessions. | IAM-05, DATA-03; Identity and Data Owner | High; 2026-07-23 | Store keyed/cryptographic digests, compare safely, preserve one-time expiry, migrate existing capabilities safely, and revoke user sessions after password reset. |
| SEC-2026-008 | Confirmed structural hazard, moderate confidence | A01/A02/A03; B06/B09/B11; F03/F05/F06 | `getCurrentPrincipalOrSystem()` falls back to a broad system principal and appears hundreds of times, including user data, memory, context, plans, people, and tool paths. Many calls may be correctly wrapped; missing context silently broadens visibility, so reachability and misuse are not yet proven per path. | IAM-02, DATA-01, AGENT-02/04/05; Identity and Data Owner with Agent Runtime Owner | High triage; 2026-07-21 | Trace request, tool, timer, hook, skill, plan, migration, and recovery call graphs. Replace user-data fallbacks with required principals; use named, narrow system principals only for documented jobs. |
| SEC-2026-009 | Confirmed structural hazard, high | A04/A05/A06; B12/B15; F10/F11 | Runtime image runs as root and intentionally includes git, Chromium/Playwright, Python, full `node_modules` including development/EAS tooling, Claude CLI/runtime, shell scripts, and `IS_SANDBOX=1` to permit skipped CLI permissions. This is functional but gives any server execution compromise a large blast radius. | EXEC-01/02/03, SUP-03/04; Agent Runtime Owner with Application and Platform Owner | High; 2026-07-23 | Separate user-serving and execution workers or sandbox high-risk work; run non-root; broker credentials; restrict egress/filesystem/processes; remove unrelated runtime tooling from each image. |
| SEC-2026-010 | Confirmed control gap, medium | A02/A05/A07; B16; F12 | Global request logging captures JSON response bodies up to 500 characters and redacts a fixed key list. Sensitive values under other field names, nested structures, draft text, or personal summaries can enter operational logs. | DATA-02/03, OBS-01; Operations Owner | Medium; 2026-08-03 | Replace response-body logging with endpoint-safe metadata or explicit allowlisted fields; classify log sources; set retention and access policy; scan historical logs without printing sensitive values. |

| SEC-2026-011 | Confirmed control gap, medium | A01/A04/A05; B13; F09 | Interrupted-plan recovery previously ran without an explicit principal. The fail-closed service fallback could not see user-owned plans, leaving attempts and sessions indefinitely active after restart. Granting an ambient system bypass would create cross-tenant mutation risk. | ORCH-01, DATA-02, AUTHZ-02; Orchestration Owner | Medium; 2026-07-22 | Repair in `server/plan-executor.ts` and `server/plan-service.ts`: named system authority performs bounded enumeration only; each mutation restores and validates the persisted owner/account principal; exact lease ownership is compare-and-swap fenced; attempt and step reconciliation is transactional; boot and periodic sweeps share one replay-safe boundary. Residual risk: a hard kill can still interrupt the non-transactional child-session projection after the canonical attempt/step transition, but the plan is truthful and the next ordinary session reconciliation can settle the projection. |
| SEC-2026-012 | Remediated control gap, high confidence | A01/A02/A08; B06/B08/B13; F03/F06/F07 | Interrupted text-chat recovery used ordinary scoped document enumeration during boot. Without a user principal it could not discover private streaming sessions, while a broad system mutation would risk cross-tenant repair and healthy work on another runtime instance. Persisted streaming state had no boot owner. | DATA-01/02, AUTHZ-02, OBS-02; Agent Runtime and Data Owner | Medium; remediated 2026-07-22 | `server/memory/document-storage.ts` exposes one bounded, content-free ordinary-user text-chat candidate query only to the named `chat-recovery` principal. `server/chat-file-storage.ts` persists runtime-instance plus boot ownership, restores the exact owner before content reads, locks and revalidates user/account/vault and document state, preserves checkpoints, and writes one replay-safe warning terminal outcome. Another runtime instance is never presumed dead. Residual risk: ownership cannot prove a different instance is dead; its own restart or a future durable liveness authority must reconcile it. |

### 11.1 Signals disproven or narrowed during reconnaissance

- REST `/api/logs` routes are guarded by authentication and `system:read`; the confirmed exposure is the separate `/ws` dashboard log stream.
- `/ws/events` authenticates the upgrade, binds a user/account principal, checks session visibility before subscription, and filters event visibility. It still needs resource, origin, and complete message-contract review, but it is not equivalent to the open `/ws` path.
- Recall webhooks use Svix-style verification and Plaid verifies non-sandbox webhooks with duplicate detection; these controls narrow those surfaces but do not prove the whole callback plane.
- Setup does refuse creation after a user exists. The residual issue is atomic first-user bootstrap and the intended policy for public registration.

## 11.2 Identity and data authority cure, July 20, 2026

The identity/data audit traced browser auth, session persistence, service bearer resolution, dashboard and event WebSockets, principal AsyncLocalStorage propagation, scoped SQL/document storage, connected accounts, object ACLs, exports, backups, context assembly, cross-session messaging, encryption, and stage/live bindings. The source and runtime metadata reviewed did not expose secret values and no active exploit was attempted.

### Closed or contained findings

| ID | Result and evidence | Framework coverage | Closure |
|---|---|---|---|
| SEC-2026-004 | Closed. `/ws` now resolves the signed session before upgrade, requires `system:read`, rejects cross-origin upgrades, and binds the principal to the socket. `/ws/events` retained its user/account binding and per-session visibility check. | ASVS V4/V7/V13; API1, API5 | Canonical upgrade boundary in `server/routes.ts`; production build passed. |
| SEC-2026-005 | Closed. First-admin setup now serializes through a PostgreSQL advisory transaction lock. Registration is invite-only unless `PUBLIC_REGISTRATION_ENABLED=true` is set deliberately. Auth ingress has bounded per-IP/email attempt budgets. | ASVS V2/V4/V11/V13; API2, API4, API6 | `server/storage.ts`, `server/auth.ts`; production build passed. |
| SEC-2026-006 | Closed for the confirmed high-risk behaviors. Authentication and password change regenerate the session ID. Password reset, password change, permission change, and account deletion revoke persisted sessions. The cookie is `HttpOnly`, production `Secure`, `SameSite=Lax`, and 12 hours. Session-authenticated unsafe requests and auth mutations reject cross-site origins. | ASVS V2/V3/V4/V13; API2 | `server/auth.ts`; production build passed. |
| SEC-2026-007 | Closed. Invite and reset capabilities are HMAC-digested before storage and lookup, with one-time clearing and expiry preserved. Legacy plaintext capabilities migrate to digests at boot. Reset completion revokes all user sessions. | ASVS V2/V6/V8; API2 | `server/auth.ts`; production build passed. |
| SEC-2026-008 | Closed for implicit escalation. Missing principal context now falls back to an unbound, permissionless service principal, so scoped reads fail closed and owned writes reject missing ownership. Explicit system jobs must enter with a named/system principal. | ASVS V1/V4/V8; API1, API5 | Canonical compatibility boundary in `server/principal-context.ts`; 69 source consumers inherit the fail-closed behavior. |
| SEC-2026-011 | Contained. The legacy archive exporter used unscoped raw SQL across user domains and job IDs were not owner-authorized. `/api/export` now returns a security hold rather than generating or serving an archive. | ASVS V4/V8/V14; API1, API3 | Canonical export ingress disabled in `server/export-routes.ts`; rebuild remains tracked below. |
| SEC-2026-012 | Closed. The reusable automation bearer token now persists as an AES-256-GCM envelope under `ENCRYPTION_KEY`, lazily migrates legacy plaintext, and rotates envelopes through `ENCRYPTION_KEY_PREVIOUS`. | ASVS V6/V8; API2 | `server/automation-auth-token.ts` and all known consumers; production build passed. |

### Coverage narrowed or verified

- Connected accounts use owner/account predicates, vault checks, encrypted token envelopes, and current/previous key rotation.
- Object reads fail closed without an ACL. Private ACLs authorize by owner or account; system/admin access is explicit.
- Backup routes require authenticated admin permission plus privileged-mode elevation. Stage and live resolve to separate Railway environments and different deployed commits. Variable names show independent database, session, encryption, and object-storage bindings, but values were intentionally not inspected.
- Cross-session message handlers resolve the caller and target through principal-scoped session storage and enforce direct parent, child, or sibling relationships.
- PostgreSQL RLS remains defense-in-depth only. The pooled application connection has no transaction-local user/account variables, so enabling RLS now would either break legitimate background jobs or create a misleading bypass through the database role. Application principal scoping remains authoritative until a dedicated transaction-scoped database identity design exists.

### Explicit residuals

| ID | Severity | Owner | Rationale and required cure | Expiry |
|---|---|---|---|---|
| SEC-2026-013 | Medium | Identity and Data Owner, @task:1130 | Rebuild data export with owner/account columns on jobs, principal-scoped queries for every domain, opaque artifact storage, bounded retention, and owner-checked status/download. Export stays disabled until then. | 2026-08-03 |
| SEC-2026-014 | Medium | Identity and Data Owner, @task:1131 | Replace process-local auth budgets with a shared store before horizontal scale or public registration. Current single-instance limits are an immediate control, not distributed enforcement. | 2026-08-03 |
| SEC-2026-015 | Medium | Identity and Data Owner, @task:1132 | Inventory active sessions per user and add explicit device/session revocation UI plus idle timestamps. Current 12-hour expiry and event-driven revocation close the confirmed high issue. | 2026-08-03 |
| SEC-2026-016 | Medium | Identity and Data Owner, @task:1133 | Design transaction-local PostgreSQL identity and restricted DB roles before evaluating RLS rollout. Do not enable RLS under the current pooled ambient role. | 2026-08-03 |
| SEC-2026-017 | Medium | Identity and Data Owner, @task:1134 | Finish replacing compatibility calls named `getCurrentPrincipalOrSystem` with explicit user or named-system entry points. The canonical fallback is fail-closed, so this is clarity and observability debt rather than ambient authority. | 2026-08-03 |
| SEC-2026-018 | Low | Identity and Data Owner, @task:1135 | Add formal retention/deletion schedules for session rows, expired capabilities, temporary export artifacts after the rebuild, and derived caches. | 2026-09-03 |

## 11.10 Session compaction integrity cure, July 21, 2026

| ID | Result and evidence | Framework coverage | Closure |
|---|---|---|---|
| SEC-2026-032 | Closed. Concurrent or replayed between-turn compaction of S2 session records can no longer duplicate model work, create multiple durable archives, or race a whole-document write across processes. `compaction_operations` encodes owner/account/vault scope, one active operation per scoped session, immutable snapshot and boundary identity, lease/reclaim state, replay-safe archive identity, and durable terminal outcome. The boot ID plus attempt count fences every transition and marker attachment, preventing a resumed stale worker from mutating an operation after another process reclaims its lease. Every chat document read-modify-write under `withConvLock` holds a transaction-scoped PostgreSQL advisory lock; compaction marker persistence and operation attachment share that transaction. Streaming assistant drafts are excluded by the model-history and snapshot producer's one canonical predicate. Bounded boot reconciliation fails stale operations and removes only their unattached compaction artifacts. | DATA-01/04/05, AGENT-04, OBS-01, REC-02; ASVS V1/V4/V8 | Canonical boundaries in `server/compaction-operation-storage.ts`, `server/compaction-snapshot.ts`, `server/chat-file-storage.ts`, and `server/content-indexer.ts`; additive migration `0086_durable_compaction_operations.sql`; production build passed in the implementation branch before merge. |
| SEC-2026-033 | Closed. S2 project milestones no longer inherit authority implicitly from an embedded JSON array that cannot carry owner/account/vault scope. Canonical `milestones` rows preserve project-local IDs with `(project_id, id)`, copy authority only from a writable parent project, and apply visible/writable scoped-storage predicates to every read and mutation. Per-project advisory transaction locks serialize ID allocation and replacement; task milestone assignments must resolve to a visible row in the named project, and removal clears owned task references atomically. | DATA-01/02, IAM-02, OBS-01; ASVS V4, API1:2023 | `migrations/0089_milestones_table.sql`, `shared/schema.ts`, `server/file-storage/projects.ts`, and `server/file-storage/tasks.ts`; additive rollback-compatible migration and production build. Residual: `vault_id` stays nullable until the next structural phase gives projects canonical vaults, so owner/account scope remains the active isolation control during backfill. |

Security gate: assets A02/A03/A08, S2 session transcripts and derived archives, flows F03/F06/F07, boundaries B06/B07/B08. Credible threats were cross-process tampering/lost update, duplicate provider-cost exhaustion, orphaned private archives, and disclosure through a streaming draft snapshot. Deterministic controls are scoped database ownership, partial unique indexes, transaction locks, exact-prefix revalidation, object ACLs, idempotent operation keys, hard time/model/input budgets, structured lifecycle telemetry, and bounded recovery. The user-visible compaction activity remains a data-minimized projection of the same operation: `/ws/events` first proves session visibility, then loads active state with the exact owner/account principal, and exposes only public status copy keyed by operation ID. Archive, summary, model, snapshot, lease, and failure details remain server-only. Residual risk is limited to object deletion retries after provider failure; failed cleanup remains logged and the private ACL continues to deny unauthorized access.

## 12. Security review and verification policy

The repository's no-test policy remains in force. Do not add or run test harnesses, unit/integration/end-to-end tests, Playwright test mode, ad hoc exploit scripts, or typecheck-only gates unless Ray explicitly changes that policy for the current work.

Allowed by default:

- Source review, Code/GitNexus tracing, diff and configuration review.
- Dependency/advisory and secret-pattern scanners that are read-only, bounded, redact values, and do not execute untrusted remediation or print secrets.
- Static analysis and artifact/provenance inspection that do not mutate provider or application state.
- Ordinary product traffic needed to verify intended behavior on the authoritative non-live target.
- The required `npm run build` production build.

Not allowed by default:

- Payload fuzzing, credential attacks, injection attempts, SSRF probes, permission-bypass attempts, denial-of-service/load tests, malware uploads, persistence, destructive actions, or attempts to access another user's data.
- Active scanning of live/production or a third-party provider.
- Any exploit attempt whose target, accounts, data, network range, rate, time window, stop condition, rollback, owner, and evidence handling have not been explicitly approved.

Active exploit testing requires explicit written scope and an isolated target with synthetic data and credentials. Production is never the first validation target. A scanner result is a hypothesis until a human traces the failed invariant and boundary.

## 13. Maintenance triggers and assurance limits

Update this document when a change adds or alters:

- a trust boundary, public route, callback, socket, SSE stream, object delivery path, or provider;
- authentication, principal, permission, account/vault ownership, secret, or sensitive data handling;
- model context, retrieval, memory, tool, autonomous behavior, browser/shell/git execution, or generated code;
- build, dependency, artifact, environment, deployment, backup, restore, logging, or incident controls.

Run a focused threat review on each such change and a full baseline review at least monthly or after a material incident. Every fourth Security Sentinel run performs the full baseline review once that skill exists.

This internal model cannot establish absence of vulnerabilities. It can establish that Mantra has named its assets and boundaries, made authority deterministic, assigned risks, and collected evidence. External human penetration testing becomes warranted before broad public access, before handling material regulated/high-value data at scale, after a major identity/execution redesign, or when customer assurance requires independent evidence.

## 11.3 Agent authority cure, July 20, 2026

### Audit scope and framework mapping

This cure traced context assembly, vNext retrieval, tool schema generation, the canonical `executeTool` dispatch, chat/voice/timer/skill/plan/workflow execution, hooks, session-tree messaging, shell/Git/platform operations, and model-controlled URL fetches. All retrieved and generated content remains untrusted. Authority is derived only from the active `Principal`, immutable invocation origin, and structured plan/workflow provenance.

Coverage maps to OWASP LLM Top 10 2025 LLM01 Prompt Injection, LLM02 Sensitive Information Disclosure, LLM04 Data and Model Poisoning, LLM05 Improper Output Handling, LLM06 Excessive Agency, LLM07 System Prompt Leakage, LLM08 Vector and Embedding Weaknesses, and LLM10 Unbounded Consumption. Agentic AI coverage includes goal/instruction manipulation, tool misuse, identity and privilege abuse, memory/context poisoning, unsafe inter-agent communication, cascading failure, and repudiation. The controls are capability boundaries, not prompt claims.

### Closed or contained findings

| ID | Result and evidence | Framework coverage | Closure |
|---|---|---|---|
| SEC-2026-013 | Closed. `/api/agent/tools/:toolName` exposed direct bridge dispatch without an explicit authentication boundary or invocation origin. It now requires authentication and enters the canonical authority policy as HTTP-originated work. | LLM01, LLM06; agent identity/privilege abuse, confused deputy | `server/routes/events.ts`, `server/agent-authority.ts`; production build passed. |
| SEC-2026-014 | Closed. Every model path previously received the complete tool registry and `executeTool` had no central capability authorization. The new boundary filters schemas and re-authorizes every call using principal permissions, invocation origin, structured delegation, human gates, and autonomous external-effect policy. | LLM01, LLM05, LLM06; tool misuse, excessive agency | `server/agent-authority.ts`, `server/bridge-tools.ts`, chat/voice/timer/autonomous callers; production build passed. |
| SEC-2026-015 | Closed. Shell accepted arbitrary `/bin/sh -c` commands behind a destructive denylist. It is now allowlist-only, denies command substitution, arbitrary interpreters/network clients/secret paths/redirection/mutating find or sed, permits only read-only shell Git and `npm run build`, and requires trusted plan/workflow provenance plus `build:write`. | LLM01, LLM02, LLM05, LLM06; arbitrary command execution and exfiltration | `server/agent-authority.ts`, `server/bridge-tools.ts`; production build passed. |
| SEC-2026-016 | Closed for model-controlled generic and image fetches. URL egress now rejects credentials, local/internal names, private/reserved IPs, and revalidates every redirect after DNS resolution. | LLM01, LLM02, LLM05, LLM06; tool misuse and exfiltration | `server/untrusted-url.ts`, `server/bridge-tools.ts`; production build passed. |
| SEC-2026-017 | Closed. Hooks were globally enumerated and dispatched from boot context, action interpolation accepted event payloads, and hook CRUD was not owner-scoped. Hook storage is principal-scoped, scheduler enumeration requires a named system principal, event audience must match the restored durable owner, execution re-enters that owner principal, and hook management requires `system:write`. | LLM01, LLM04, LLM06; identity/privilege abuse, replay, repudiation | `server/hook-storage.ts`, `server/hook-executor.ts`, `server/routes/hooks.ts`; production build passed. |
| SEC-2026-018 | Closed. The generic session `send_message` path could target an arbitrary visible session while the dedicated tools correctly enforced tree topology. Generic delivery now accepts only a direct parent, child, or sibling and preserves the chain-depth cap. | LLM01, LLM04, LLM06; unsafe inter-agent communication, cascading failure | `server/bridge-tools.ts`, existing `server/session-tree.ts`; production build passed. |
| SEC-2026-019 | Closed. A workflow stage child could recursively create and start another workflow, multiplying model, provider, deployment, and tool authority beyond its assigned stage. Workflow creation now rejects sessions durably linked as `workflow_sessions.role = stage_attempt`; the workflow state machine alone owns downstream orchestration. | LLM06, LLM10; excessive agency, cascading failure, unbounded consumption | `server/workflows/workflow-service.ts`, `server/AGENTS.md`; production build passed. |

### Preserved controls and residual risk

The Claude SDK keeps built-in Bash/file/web/task tools disabled and exposes only Mantra MCP definitions. Tool-call idempotency remains `(runId, toolCallId)` scoped; write ordering, plan/workflow terminal ownership, admission budgets, session spawn idempotency, session chain-depth caps, principal-scoped vNext retrieval, bounded tool-output artifacts, and human-only Gmail sending remain in force.

Residual medium risks are tracked for later application/platform review: domain-specific URL adapters and provider callbacks need complete egress/replay verification; the bridge monolith still has uneven action schemas and some tools default conservatively to external-effect; hook names remain globally unique, which is a tenancy usability constraint rather than an authority bypass; shell allowlisting is intentionally narrow and may require explicit expansion as trusted engineering workflows evolve. No known unowned critical/high finding remains in the audited agent-authority plane.

## 11.4 Application and platform boundary cure, July 20, 2026

**Scope.** Current `main` was inventoried from the Express composition root and all statically declared server route registrations. The inventory contained 1,042 route declarations representing every exposed REST family; after this change, zero statically declared `/api` routes are unclassified. Dynamic and parameterized endpoints inherit the owning prefix or explicit regular-expression decision. WebSocket upgrades, SSE, object storage, mobile WebViews, container capabilities, Railway bindings, and release/provider metadata were separately inspected because route counting does not cover those boundaries.

### Enforced interface decisions and abuse budgets

| Interface | Trust decision | Enforced control | Budget / owner |
|---|---|---|---|
| Public bootstrap, health, acquisition, and capability-token routes | Anonymous only where the route is explicitly listed | API policy is enforce-by-default; unknown APIs return 404 | 120 requests/minute/IP; Security owner |
| Personal APIs | Session, service, or system principal plus downstream object/domain ownership | Canonical API policy + existing principal/scoped-storage enforcement + same-origin session mutation defense | 300 requests/minute/IP; domain owner |
| Admin APIs and diagnostics | Admin or system principal | Canonical API policy; dashboard log WebSocket also requires `system:read` | 120 requests/minute/IP; Platform owner |
| Service execution APIs | Service/system/admin principal | Canonical API policy and deterministic capability boundary | 600 requests/minute/IP; Agent Platform owner |
| Provider webhooks | Anonymous network ingress, authenticated by provider proof before side effects | Recall Svix HMAC + 5-minute timestamp; Plaid ES256 JWT + 5-minute age + body hash; Twilio HMAC-SHA1 over canonical URL/form body | 600 requests/minute/IP plus provider retries; Integrations owner |
| WebSocket/SSE | Explicit per-upgrade principal, signed provider stream, or unguessable pending-call/session binding | Upgrade allowlist, session resolution, origin check on browser dashboard socket, bounded provider/session maps, connection teardown | Provider/browser lifecycle budget; owning transport team |
| Upload/object read | Authenticated user principal; private ACL by default | 100 MB/one-file proxy limit, 15-minute content-type-bound signed PUT, principal/vault keying, ACL check before download | 100 MB proxied request; Storage owner |
| Mobile WebViews | Only the configured first-party HTTPS origin receives cookies or native bridge authority | Trusted-origin navigation allowlist, no third-party cookies, no file/universal-file access, no mixed content, no popup windows | One first-party origin; Mobile owner |
| Runtime browser/git/shell/Claude capabilities | Required product capabilities, never container-root authority | Runtime `mantra` user, deterministic capability policy, allowlisted shell commands, explicit tool permissions | Existing execution time/resource ceilings; Platform owner |

### Closed or contained findings

- **SEC-APP-001, high, API inventory/policy fail-open. Closed.** `API_POLICY_ENFORCEMENT` previously defaulted to report-only and 98 route declarations sat outside the policy vocabulary. Enforcement now defaults on, report mode requires an explicit temporary override, every current static API route is classified, and unknown APIs fail closed. Evidence: `server/api-policy.ts`; static inventory result `1,042 / 0 unclassified`.
- **SEC-APP-002, high, Twilio callback forgery. Closed.** All three phone callbacks accepted unsigned form posts before mutating pending call/session state. They now require `X-Twilio-Signature`, reconstruct the provider URL behind the trusted Railway proxy, sign sorted form parameters with the stored auth token, and compare in constant time before processing. Evidence: `server/phone/routes.ts`; Twilio Webhooks Security contract.
- **SEC-APP-003, high, Plaid sandbox fail-open. Closed.** Missing, stale, malformed, or unverifiable Plaid JWTs could pass whenever `PLAID_ENV=sandbox`. All environments now fail closed; ES256 verification, five-minute maximum token age, and raw-body SHA-256 binding remain mandatory. Evidence: `server/routes/plaid.ts`, `server/plaid-service.ts`; Plaid webhook verification contract.
- **SEC-APP-004, high, mobile native-bridge origin authority. Closed.** A first-party authenticated WebView could navigate to another origin while retaining JavaScript/native bridge privileges and shared-cookie configuration. Mobile backend URLs now require HTTPS except loopback development, each WebView permits only its configured origin, and file access, mixed content, third-party cookies, and popup windows are disabled. Evidence: `mobile/src/config.ts`, `mobile/src/lib/webview-security.ts`, three WebView composition sites.
- **SEC-SUP-001, high, root runtime execution. Closed.** The production image intentionally retains browser, git, Node build tools, and Claude CLI for product execution, but those capabilities no longer run as root. The runtime creates and switches to a dedicated `mantra` user after provisioning. Evidence: `Dockerfile`.
- **SEC-ING-001, high, global upload and HTTP blast radius. Contained.** The global JSON boundary remains 50 MB because current image and provider callback flows depend on it, but every API class now has a named request budget; multipart proxy uploads fell from 2 GB to 100 MB, one file, and eight fields. Larger media must use the 15-minute presigned path. Evidence: `server/index.ts`, `server/api-policy.ts`, `server/object_storage/routes.ts`.
- **SEC-APP-005, high, ElevenLabs custom LLM callback exposure. Closed.** The OpenAI-compatible SSE ingress previously relied on an uncredentialed public URL. Agent configuration now receives an HMAC-derived path capability bound to `SESSION_SECRET`; every callback compares it in constant time before session resolution, and logs never print the capability URL. Evidence: `server/elevenlabs.ts`, `server/routes/voice-session.ts`; ElevenLabs Custom LLM configuration contract.
- **SEC-APP-006, low, meeting transport shutdown integrity. Closed.** A Recall participant-audio socket ending during an owner-requested departure could close its downstream Scribe socket with code 1006 before Recall's terminal webhook arrived. That provider callback overwrote the user-owned A02 recognition stream as failed across B04/F02 even though the meeting lifecycle was already leaving and the recap completed. Provider close is now replay-safe, intentional teardown suppresses downstream errors, stream ownership fences stale callbacks, and the durable meeting lifecycle classifies close-versus-failure at the producer boundary. Owner: Integration Owner. SLA: closed in the reporting change. Evidence: production session `mruumdr16h9r8f`, Recall `bot_received_leave_call`, `server/meeting/stt.ts`, `server/voice/stt.ts`; current Recall real-time endpoint and ElevenLabs Scribe lifecycle contracts.
- **SEC-WEB-001, high, sparse browser headers and error disclosure. Closed.** Responses now set an explicit CSP, HSTS in production, frame controls, MIME protection, referrer policy, permissions policy, and opener policy. Unexpected 5xx responses no longer reflect internal exception messages to clients. Evidence: `server/index.ts`.

### Verified controls and narrowed hypotheses

- Recall status and transcript callbacks already verify signed raw bodies, enforce a five-minute timestamp tolerance, require provider-formatted secrets, route through bot-owned session metadata, and use replay-safe ingest identifiers. No critical/high cure was required.
- Live meeting audio-source policy changes require an authenticated owner principal, validate the selected source against the meeting's canonical non-bot recognition streams, deduplicate client retries under the conversation lock, and publish only owner/account-scoped runtime transitions. Recall audio transport applies the change only when the durable meeting owner and stable source key both match. No display label or Person identity carries routing authority.
- Object storage reads already require authentication and principal-aware ACL authorization. Writes are vault/principal keyed and private by default. Presigned PUTs expire after 15 minutes and bind content type. Remaining MIME/decompression analysis is medium risk because untrusted files are not executed by the server's static origin.
- Browser dashboard and event WebSockets authenticate during upgrade; the dashboard socket requires `system:read`. Recall and Twilio streaming sockets bind to signed callback-created session state. Stream consumers have lifecycle teardown and message/turn bounds. Distributed per-account quotas remain a medium availability hardening item.
- XSS inspection found one `dangerouslySetInnerHTML` sink in the chart style generator. Its values come from compile-time/configured color tokens, not user rich content. TipTap/Markdown surfaces use structured renderers rather than raw HTML injection. The CSP materially limits residual impact.
- Session-cookie mutations already enforce same-origin using Origin/Host and Fetch Metadata, while bearer requests are not subject to browser CSRF. CORS is intentionally same-origin; no permissive global CORS middleware is present.
- Stage and live are distinct Railway environment and service bindings. Stage tracks `main` with manual deployment; live tracks `live`. Runtime variable names are equivalent, but values were not inspected. This proves configuration separation, not independent credential material. Credential-value independence remains a readiness-review evidence item.
- GitHub source binding, Railway hosting binding, and EAS account are stored provider connections rather than source secrets. Root and mobile lockfiles are committed. Dependabot is now configured for both npm roots. CodeQL is feasible but remains gated by the repository's explicit no-workflows rule and Git token workflow-scope constraint; the independent readiness step should decide whether to change that release policy.

### Framework calibration

This cure addresses ASVS 5.0 areas for architecture, access control, validation, web frontend security, files/resources, API/web services, configuration, and logging; OWASP API Top 10 2023 API2, API4, API7, API8, and API10; MASVS 2.1 STORAGE, NETWORK, PLATFORM, CODE, and PRIVACY controls; NIST SSDF PO.5, PW.4, PW.6, RV.1, and RV.3; CISA Secure by Design secure defaults and ownership; and OpenSSF/SLSA source/dependency/provenance expectations. Calibration is evidence-based. It is not a certification claim.

### Residual risks and owners

| ID | Severity | Residual | Owner | Target |
|---|---|---|---|---|
| SEC-APP-R1 | Medium | Replace process-local IP budgets with shared account/principal-aware quotas for horizontally scaled instances and expensive endpoints. | Platform | August 17, 2026 |
| SEC-APP-R2 | Medium | Split the 50 MB global JSON parser into narrow raw/provider and media routes with a 1 MB default. Current broad limit is retained for compatibility. | Server | August 17, 2026 |
| SEC-MOB-R1 | Medium | Deep-link actions can start voice/vision from any OS-dispatched URL matching the app scheme. Add signed universal/app-link ownership and foreground confirmation for camera actions. | Mobile | August 17, 2026 |
| SEC-SUP-R1 | Medium | Confirm stage/live use independent database, object-store, encryption, session, and provider credentials through human/provider evidence without revealing values. | Platform | Readiness review |
| SEC-SUP-R2 | Medium | Decide and enable CodeQL or equivalent read-only SAST after explicitly revising the repository no-workflows constraint and credential scope. | Engineering | August 17, 2026 |
| SEC-SUP-R3 | Closed | Dependency cure recorded in §11.5: both committed graphs now report zero critical and zero high findings. | Engineering | Closed July 20, 2026 |
| SEC-OBS-R1 | Medium | Response telemetry redaction remains vocabulary-based. Move to allowlisted structured fields and data classification at emitters. | Observability | August 17, 2026 |

**Rollback.** No schema or production mutation is included. Revert the merged PR on `main` to restore the prior application image; stage remains the first deployment target and live still requires the existing human promotion path.

## 11.5 Dependency advisory cure, July 20, 2026

**Scope and provenance.** Current GitHub Advisory Database evidence was queried through npm against the committed root and mobile lockfiles before and after remediation. The root baseline was 35 findings: 3 critical, 18 high, 13 moderate, and 1 low. The mobile baseline was 25 findings: 1 critical, 18 high, and 6 moderate. Verification used both `npm audit --json` and `npm audit --omit=dev --json`; no install, lifecycle script, active exploit, or uncommitted dependency tree was used as evidence. `package.json` plus `package-lock.json`, and `mobile/package.json` plus `mobile/package-lock.json`, remain the reproducible sources of truth.

### Critical/high closure and reachability

| Advisory family | Baseline reachability | Closure evidence |
|---|---|---|
| `protobufjs` | Shipped through the ONNX runtime used by GitNexus embeddings. Crafted descriptor/message data could reach generated conversion code. | Root override resolves `protobufjs` 7.6.5 and `@protobufjs/utf8` 1.1.2. GHSA-xq3m-2v4x-88gg and the linked high findings no longer appear. |
| `simple-git` | Runtime transitive of QMD's local `node-llama-cpp`; repository inputs cross an execution boundary. | Root override resolves 3.36.0. GHSA-jcxm-m3jx-f287, GHSA-r275-fr43-pm7q, and GHSA-hffm-xvc3-vprc no longer appear. |
| `tar` | Runtime transitives of ONNX, LadybugDB/GitNexus, and Expo tooling; extraction can write files during dependency/tool operation. | Root and mobile override to 7.5.20. The node-tar traversal, overwrite, parser, and unbounded-input chain, including GHSA-23hp-3jrh-7fpw, no longer appears. |
| `drizzle-orm` | Direct, pervasive server data boundary. Dynamic SQL identifiers are security-sensitive even when current callers are controlled. | Direct floor is 0.45.2. GHSA-gpj5-g38j-94v9 no longer appears. |
| `axios`, `form-data`, redirect stack | Runtime through Plaid and build/runtime tooling; outbound URLs, credentials, headers, streams, and multipart fields cross trust boundaries. | Overrides resolve Axios 1.18.1, form-data 4.0.6, and follow-redirects 1.16.0. The reported SSRF, prototype-gadget, credential-leak, resource, and CRLF advisories no longer appear. |
| `ws` | Direct server dependency for authenticated browser, meeting, voice, provider, and telemetry sockets. | Direct root floor and mobile override resolve 8.21.1. GHSA-96hv-2xvq-fx4p and GHSA-58qx-3vcg-4xpx no longer appear. |
| `multer` | Direct upload parser on chat, object storage, voice, and demo routes. Untrusted multipart bodies reach it. | Direct floor is 2.2.0. The five reported cleanup, recursion, and resource-exhaustion advisories no longer appear. Existing route file/field/size budgets remain required. |
| Hono and MCP server | Runtime transitives of the Anthropic/MCP tool plane. Static serving is not Mantra's product boundary, but middleware and transport code are executable. | Overrides resolve Hono 4.12.31 and `@hono/node-server` 1.19.13. Static-path, CORS, and middleware-bypass advisories no longer appear. |
| `fast-uri`, `lodash`, `lodash-es`, `linkify-it`, `minimatch`, brace expansion, path routing, XML/YAML utilities | Runtime or build-time parser/matcher code. Several are reachable from user-controlled text, URL, graph, Markdown, repository, or configuration input; the rest execute in trusted build tooling but remain owned supply-chain code. | Explicit floors/overrides resolve fast-uri 4.1.1, lodash/lodash-es 4.18.1, linkify-it through the patched Markdown chain, safe minimatch/brace-expansion/path-to-regexp ranges, xmldom 0.8.13, js-yaml 3.15.0/4.3.0, shell-quote 1.10.0, and patched PostCSS/AJV families. Their critical/high advisories no longer appear. |
| Claude, GitNexus, browser, and EAS capability graph | Required product/tooling capabilities. Removal would have hidden findings by deleting functionality rather than curing its producer. | Claude Code advances to 2.1.216; Playwright remains present; EAS remains present; GitNexus is pinned to the previously proven 1.4.5 because the floating 1.4.8 graph introduced an advisory-bearing ONNX/adm-zip chain. Their required capabilities remain represented in the root lockfile. Expo SDK 52 remains pinned while vulnerable utility implementations are overridden rather than forcing an unreviewed SDK-generation migration. |

**Result.** Root full and production-only audits each report 0 critical, 0 high, and 4 moderate. Mobile full and production-only audits each report 0 critical, 0 high, and 16 moderate. SEC-SUP-R3 is closed. No known unowned critical/high npm advisory remains in either committed graph as of this evidence date.

### Medium residuals

| ID | Residual | Reachability and ownership | Target |
|---|---|---|---|
| SEC-SUP-R4, @task:1139 | Root Google API chain reports four moderate nodes around `uuid` GHSA-w5hq-g745-h8pq (`uuid`, `gaxios`, `googleapis-common`, `googleapis`). | Server Google integrations are runtime reachable, but Mantra does not call UUID v3/v5/v6 with a caller-provided output buffer, the advisory's required primitive. Upgrade `googleapis` after compatibility review rather than accepting npm's forced major blindly. Engineering owns this residual. | August 17, 2026 |
| SEC-MOB-R2, @task:1140 | Mobile reports 16 moderate aggregate nodes in the Expo SDK 52 build/dev-client/config chain, rooted primarily in old UUID use and propagated package severity. | Expo CLI, plist/config plugins, Metro, dev launcher, and Xcode helpers execute during trusted local/EAS build or development. They are not bundled application request handlers. The specific UUID buffer primitive is not called by Mantra. Upgrade the Expo/React Native generation as one compatibility mission; do not mix it into a transitive utility cure. Mobile owns this residual. | August 17, 2026 |

**Operational rule.** Advisory closure expires when a lockfile changes or the advisory database changes. Security Sentinel must compare both committed graphs to current advisory evidence, treat aggregate package severity as a dependency chain rather than duplicate vulnerabilities, and reopen a finding when a new critical/high appears. A clean audit is evidence about known package advisories, never proof that the dependency graph is safe.

## 11.6 Independent readiness red-team cure, July 20, 2026

The independent review reopened **SEC-2026-015** after tracing the trusted engineering shell from model arguments through `executeTool` to `/bin/sh`. The original allowlist blocked explicit interpreters and command substitution, but GNU sed's command language still accepted an executable `e` expression, direct shell variable expansion remained legal, and the child inherited the complete server environment. A prompt-influenced trusted plan or workflow could therefore turn read-shaped shell syntax into arbitrary execution and disclose A04 credentials from the server process. This was a high authority and secret-exposure finding across B12/B15 and F10/F11.

**Closed.** `server/agent-authority.ts` now permits sed only as a numeric print-range reader, rejects variable expansion, absolute paths outside `/app`, path traversal, and executable/write-capable modes in other allowlisted utilities, removes credential-bearing Git remote inspection, and accepts only the exact production build script for npm. `server/bridge-tools.ts` now launches the sole shell child with a positive environment allowlist, isolated home/temp/cache state, disabled Git prompts/config/hooks, disabled npm user config, and build-time provider/database mutation flags forced off. No database, session, encryption, provider, platform, or deployment credential is inherited by the model-controlled child.

This is defense in depth rather than a sandbox claim. `npm run build` intentionally executes repository code when trusted interactive/plan/workflow provenance has `build:write`; an untrusted repository can still attack the filesystem and network under the runtime OS account. Code authoring is explicit rather than hidden in shell syntax: `scratch.write`/`scratch.edit` may mutate only the current session-owned `repos/*-{sessionId[:8]}` clone, and those actions now cross the same principal permission and trusted-engineering boundary as Git writes. The mutation handler resolves the repository root plus existing target or parent through the filesystem before writing, so cross-session paths and symlink escapes fail closed. The external execution-worker/sandbox separation remains a medium residual under Agent Runtime and Platform ownership, target August 17, 2026. Closure evidence is the canonical authority and spawn boundaries, read-only static enumeration, clean aggregate dependency audits, tracked-file secret-pattern scan, and a passing production build. The same review found two stale-dependency-tree false negatives after the advisory upgrade. `react-icons` removed `SiLinkedin`, so the People page now uses the existing Lucide `Linkedin` icon. Claude Code 2.1.216 also moved its executable contract from `cli.js` to the declared `bin.claude` entry and requires Node 22; qmd carries the same Node floor. The production bundler and runtime resolver derive the executable from package metadata and fail loudly when the declared artifact is absent. Builder and runtime therefore use Node 22. The image stamps its full development dependency tree with the root lockfile hash; clone validates that immutable contract and symlinks it into the session workspace. Live requests never run `npm ci` against `/app`, preventing partial dependency-tree mutation and concurrent hydration races. Railway's fresh install is the clean-install acceptance boundary. No active exploit was run and no secret value was accessed or printed.


## 11.7 Independent readiness tenant-boundary cure, July 20, 2026

The independent review confirmed **SEC-2026-020, critical** after re-enumerating context assembly and ID-addressed tool paths. `context-builder.ts` loaded `coding_process` and `planning_process` artifacts from every Platform Environment and dereferenced their `library_pages` without proving that either the parent Platform or linked page was visible to the current principal. Engineering preflight repeated the pattern for `design_system`. A second tenant could therefore link a private Library page and have its S2 content enter another user's model prompt, creating both cross-user disclosure and durable prompt injection across B06/B08/B09/B12. No active exploit was run, no affected production row was identified, and no secret value was accessed.

Adjacent review found the same missing principle in Gmail `email_cache.get_message`, goals/check-in artifact resolution, meeting artifact linking, Platform context-artifact routes/tools, and Platform child enumeration. Those paths exposed bounded BOLA disclosure, unauthorized foreign-link creation, or confused-deputy risk even when later consumers happened to filter some content.

**Closed in source.** `server/platforms/platform-access.ts` is now the canonical parent-authority boundary for Platform children. `server/platforms/context-artifact-access.ts` joins context artifacts through a principal-visible Platform and a separately principal-visible Library page. Context assembly and engineering preflight use that reader. Gmail message/enrichment lookups, goals and meeting page resolvers, period-artifact dereference, and Platform route/tool context links apply principal visibility at the SQL boundary. Historical invalid links fail closed. The build-lifecycle service reuses the same Platform authority module.

**Framework mapping.** ASVS 5.0 V1/V4/V5/V8/V13/V14; OWASP API1, API3, API5, API8, API10; OWASP LLM01, LLM04, LLM06, LLM08; OWASP Agentic identity/privilege abuse, memory/context poisoning, tool misuse, and cascading behavior; NIST SSDF PW.4, PW.5, PW.7, RV.1, RV.2.

**Incident and release decision.** The source path blocks readiness until the cure is merged and current `main` passes the production build. No credential rotation is indicated without evidence that S0/S1 data or credentials entered a foreign context. If logs or database review later show cross-tenant artifact links or foreign context delivery, declare an incident, revoke affected sessions, preserve prompt/tool-call evidence, remove the links at their producer boundary, notify affected users, and rotate only credential classes proven exposed. Rollback is the merged PR revert; no schema or live mutation is part of this cure.


## 11.8 Canonical meeting preparation boundary, July 22, 2026

**SEC-MEET-001, high, closed in source.** Meeting preparation is A02/S2 data crossing F02/F04/F05/F06 and B03/B06/B10/B11. The confirmed control gap allowed REST, model tools, and autonomous skill policy to create or link parallel agenda and brief pages. The REST artifact route also resolved Library IDs with unscoped raw queries. A caller could therefore create split meeting-preparation identity, race another producer into a second page, replace the page other systems considered authoritative, or attempt a foreign-page confused-deputy link.

The deterministic boundary is `calendar_event_metadata.agenda_library_page_id` plus `server/calendar-metadata.ts:setMeetingAgendaPage`. Claims serialize under a meeting-scoped PostgreSQL advisory transaction lock, re-read principal-writable metadata, validate principal-visible Library pages, and fail closed when a different page already owns the slot. Agenda and legacy brief operations converge there. A partial unique artifact index permits one legacy prep link per meeting, and generic artifact linking requires an explicit non-preparation kind. Canonical prep links cannot be removed through generic unlink. Code-owned autonomy and Daily Brief instructions migrate monotonically under `author=system`, `customized=false`, and expected-version guards; prompts reinforce but do not carry enforcement.

Controls: IAM-02, DATA-01, ING-01, AGENT-01, AGENT-03, OBS-01. Owner: Application Security Owner. Closure evidence: `shared/schema.ts`, `migrations/0088_canonical_meeting_prep.sql`, `server/schema-bootstrap.ts`, `server/calendar-metadata.ts`, `server/calendar-routes.ts`, `server/bridge-tools.ts`, `server/tool-registry.ts`, `server/tool-details.ts`, `server/skill-seed.ts`, production build, and merged PR. Residual risk: older binaries in a rolling deployment may receive a unique-conflict failure when attempting a second prep page; this fails closed. Historical duplicate Library pages are unlinked but retained because independent content use cannot be disproven. Rollback is the merged PR revert; the additive nullable pointer is safe to retain.

## 11.8a Library2 placement boundary, July 21, 2026

**SEC-LIB-001, high, closed in source.** Library2 introduces a user-owned organizational join over S2/S3 Library metadata. The credible failure modes are cross-account page enumeration, placement into another account's or archived vault, forged non-Index destinations, replay duplication, unbounded subtree import, conflict updates against another principal's row, and deletion of the underlying Library page instead of the lens record.

The deterministic boundary is `server/library-placement-store.ts` plus `server/library2-placement-service.ts`. Source pages and joined page rows use principal-visible scope predicates. Placement reads use principal-visible scope; updates and deletes use writable scope. Destination vaults must match the principal account, remain live, and belong to the canonical persisted `users.visible_vault_ids` set carried on the request Principal. Hidden vaults are excluded from destination, placement, and mutation reads while their pages and placements remain intact. Destinations must resolve from a principal-visible canonical Index heading or a visible Wiki page named by that Index; the selected canonical Index path is persisted on the placement and never accepted as caller authority by itself. Bulk imports cap at 5,000 pages, traverse descendants in bounded batches with cycle deduplication, validate the derived import key, and commit through one replay-safe transaction backed by the unique `(page_id, vault_id)` identity. A foreign uniqueness conflict fails closed. The API policy classifies `/api/library2` as personal. Removing from Library2 deletes only the owned placement row; `library_pages` content and Library1 hierarchy are untouched.

Residual risk is limited to semantic suggestion quality. The suggestion may choose no destination or a poor candidate, but it cannot broaden authority or write until the user confirms a valid canonical destination. Rollback is the merged PR revert; the placement schema is additive and Library page rows remain authoritative.

## 11.8b Library cross-vault transfer boundary, July 22, 2026

**SEC-LIB-002, high, closed in source.** Library hierarchy transfer moves A02 S2/S3 content across B06 user/account/vault isolation through F02 REST and F03 model-tool flows. The confirmed gap was split mutation authority: REST reparent paths prohibited cross-vault moves, the model Library tool could write `parent_id` independently, and reviewed corpus migration wrote `parent_id` plus `vault_id` directly. A forged or stale destination, concurrent move, or partial failure could create parent-vault mismatch, split a descendant subtree across vaults, move protected content, or leave Library2 placement membership divergent from canonical `library_pages.vault_id`.

The deterministic boundary is `server/library-move.ts`. Every discovered reparent, reorder, tool update, and reviewed migration path delegates to one transaction. The request carries separate `destinationVaultId` and destination parent fields, so a null parent identifies only the explicit vault root. The boundary requires the complete source subtree to be principal-visible and writable, rejects protected/meta/system content and pre-existing split-vault trees, validates the destination vault against the principal account, persisted visible-vault set, and live archival state, and requires any destination parent to be writable and belong to that exact vault. Recursive traversal is cycle-safe and capped at 5,000 pages. Stable sorted advisory locks cover source/destination sibling sets and every subtree parent key before validation and mutation. The transaction shifts sibling order, updates every descendant `vault_id`, reparents the root, and clears only Library2 placement parent references that became cross-vault-invalid. Library2's independent organizational vault placements remain intact. Retries converge on the same state; serialization and hierarchy races fail with retryable conflict semantics. Attempted and completed cross-vault transfers emit identifiers and counts only, never titles or content.

Threat mapping: STRIDE spoofing, tampering, elevation of privilege, and repudiation; OWASP API1/API3/API5; IAM-02, DATA-01, DATA-04, AGENT-01, AGENT-03, OBS-01. Owner: Application Security Owner. Closure evidence: scoped impact analysis of the prior REST guard, Move dialog, drag reorder, placement store, and corpus migration; `server/library-move.ts`; `server/routes/library.ts`; `server/bridge-tools.ts`; `server/library-corpus-migration.ts`; `server/tool-registry.ts`; client Move destinations; passing production build; merged PR. Residual risk: repository policy forbids active authorization exploit testing and tests, so evidence is static scope review plus the production build. Rollback is the merged PR revert; no schema migration is required.

## 11.9 Memory graph recency integrity, July 21, 2026

The Memory Graph exposes S1 personal memory, People, Library, and session relationships across B06/B09 and F03. The credible abuse case is cross-tenant graph expansion or a passive context read mutating active history, which could disclose private nodes or create a false audit trail of user activity. Controls remain deterministic: the endpoint selects only principal-visible active claims; relation, Person, Library, and session lookups retain their principal-scoped storage boundaries; relation fan-out is processed in bounded batches; and context assembly updates only passive recall diagnostics. A separate `active_touched_at` column records explicit claim reads and successful link mutations through one writable-scope helper. No new route, permission, model authority, provider transfer, or public callback is introduced. Residual risk is limited to existing principal-context and source-data integrity assumptions already owned by IAM-02, DATA-01, and AGENT-05. Rollback is the merged PR revert; the additive nullable column is safe to retain. Verification evidence is repository impact search, scoped diff review, and the production build.

### Exact inference payload inspection boundary (2026-07-22)

The Context viewer now persists the complete secret-free request visible at each text-provider dispatch boundary so a user can inspect one concrete call rather than a reconstruction. This introduces an S3-sensitive-data store containing system prompts, user messages, history, tool schemas, and tool results. The credible threats are cross-user disclosure and accidental credential capture. Deterministic controls are mandatory user-principal ownership on insert, `visibleScopePredicate` on every read, transactional retention of the newest 20 rows per user/account, and provider-specific safe projections that exclude authorization headers, credentials, environment variables, executable paths, callbacks, abort signals, and opaque SDK runtime instances. Direct Anthropic and OpenAI captures use the exact request object handed to the provider client. Claude Agent SDK captures stop at the authoritative `query({ prompt, options })` boundary and label the hidden downstream SDK request, harness, and reminder envelopes as unobservable rather than inventing them. Residual risk is deliberate exposure of highly sensitive prompt content to its owning authenticated user and dependence on principal propagation through model calls. Rollback is the merged PR revert; the additive table may remain inert. Verification evidence is architecture and impact tracing, official Agent SDK documentation review, scoped diff review, and the production build.

## 11.10 Project attachment object authorization, July 21, 2026

**SEC-OBJ-001, high, closed in source.** Project attachments are user-owned S2/S3 artifacts crossing F04/F06/F07 and B06/B07/B10. The `work.add_file` producer previously wrote project-upload objects without an ACL, while object delivery correctly failed closed when no ACL existed. A user who could see their project therefore received 403 for its historical attachments, including Library wireframes embedded from that project. The same handler also accepted a caller-supplied object path without first proving object visibility, creating a latent confused-deputy risk if historical access were repaired only at the delivery route.

The canonical controls now meet at both boundaries. New workspace uploads require a current authenticated user principal and write a private user/account ACL on the actual object key. Caller-supplied object paths must already be readable by that principal before they can be attached. Object delivery retains ACL authorization as the primary path and grants historical fallback access only when a principal-visible project contains the exact `/objects/...` path in its bounded attachment array. Parent visibility uses the canonical scoped project predicate, so a foreign project never grants access. This cures availability without making attachments public or weakening tenant isolation.

**Threat and mapping.** Unauthorized object disclosure and attachment laundering under STRIDE information disclosure/elevation of privilege; OWASP API1/API3/API5; DATA-01, DATA-04, IAM-02, IAM-03, AGENT-03. Owner: Engineering. Rollback is the merged PR revert; no schema migration or destructive data rewrite is required. Closure evidence requires a passing production build, merged source, and authenticated browser proof that a visible historical project attachment renders while an unlinked object remains denied.

## 11.11 Meeting identity and recap sender evidence boundary, July 21, 2026

Meeting transcripts, calendar identities, People links, recaps, follow-up drafts, and connected Gmail accounts carry S1/S2 relationship data across the signed Recall callback boundary, owner-authenticated correction boundary, and Google account boundary. The credible abuse cases are a provider-controlled display name impersonating an invitee or organizer, and an external Google event organizer being mistaken for the authorized Mantra sender. Either can create false attribution or select an identity the principal does not control.

The deterministic speaker control is evidence precedence in the meeting session: owner manual assignment, then exact calendar/People identity, then transport evidence, with anonymous machine diarization remaining unresolved. The deterministic email control separates three authorities: `CalendarEvent.accountId` identifies the principal-visible connected account that fetched the exact event and may author the Mantra draft; Google `event.organizer` records event authorship and remains a recipient when external; invitees plus external organizer define recipients after the sender account is removed. Signed Recall payloads restore the durable meeting owner principal before any People or session read. Manual mutation remains owner-only, validates the selected Person through principal-scoped People storage, rewrites all messages sharing the stable speaker key, and reconciles recap references plus People interactions. Failed distribution rows are replaced only through the owner-authenticated replay-safe distribution path. Explicit ensure actions may retry immediately; identity correction retries only after every stable speaker has a canonical Person identity. Completed drafts remain immutable.

Residual risk is ambiguous audio when Recall provides neither email nor trustworthy host status and multiple calendar participants remain unbound; the system preserves that speaker for explicit assignment rather than guessing. A connected calendar account lacking Gmail authority can still fail at the canonical draft/send boundary and must surface that failure without falling back to another identity. Owner: Meeting Agent. Rollback is the merged PR revert; the session-document contract is additive and backward compatible.

## 11.12 Independent readiness API-policy drift cure, July 20, 2026

A fresh merged-main inventory found nine of 1,042 statically declared API routes had drifted outside the explicit API policy: admin-only Recall, Twilio, Deepgram, and Meta wearable status/configuration routes plus the authenticated browser-telemetry summary. The policy's default-deny behavior returned 404 before route-local guards, so this was a fail-closed availability/configuration defect rather than an authorization bypass. It still invalidated the zero-unclassified readiness control and demonstrated that route inventory must be rerun after every main change.

**Closed in source.** `server/api-policy.ts` now classifies the eight integration routes as admin and the telemetry summary as personal. Route-local `requireAuth` and admin guards remain defense in depth. The merged-main static inventory must report `1,042 / 0 unclassified`, and the production build must pass before readiness is issued. Mapping: ASVS V1/V4/V7/V13/V14; OWASP API5, API8, API9; NIST SSDF PW.4, PW.7, RV.1.

## 11.12 Assistant checkpoint durability review, July 21, 2026

This change persists the already-authorized, already-user-visible `SessionManager` transcript during an active text turn so process interruption cannot erase prose boundaries, tool calls, or diagnostic chronology. It introduces no new route, principal, provider, or data class. The write remains inside the existing principal-scoped chat document and `updateAssistantDraft` session lock; late checkpoints remain fenced once the assistant row leaves `streaming`. The projection stores only fields already present in the durable assistant-message contract. Security result: no new finding. Availability and transcript integrity improve without broadening read or write authority.

## 11.13 Runtime accounting repair review, July 21, 2026

The affected assets are private vNext claim metadata and autonomous execution capacity. The credible threats are failed lifecycle writes causing repeated model work, and misleading admission diagnostics obscuring unbounded resource consumption. The deterministic controls remain principal-scoped claim mutation with replay guards and controller-owned admission state. Blocking child execution now has an explicit suspended ownership state rather than appearing as an unowned admitted run. Confidence-decay audit metadata crosses the SQL boundary as one application-constructed value with an explicit `jsonb` type, so valid nullable fields cannot trigger polymorphic parameter inference and replayed extraction. No route, permission, principal, provider, or data class gains authority. Security result: no new finding. Availability observability improves while memory ownership and admission budgets remain unchanged. Residual risk is process-local loss of operational admission state on restart; canonical session and run recovery remain responsible for truthful terminal reconciliation.

## 11.14 Calendar schema auto-heal integrity review, July 22, 2026

Calendar metadata, linked meeting artifacts, and participation mode are A02/S2 state crossing the system-owned boot migration boundary and principal-scoped runtime mutation paths. Two fail-open boot repairs weakened integrity without broadening direct read or write authority: a legacy artifact table missing timestamp columns aborted metadata deduplication before the unique event/account/calendar index could be installed, and malformed PostgreSQL dollar quoting prevented the meeting join-mode check constraint from being created. The credible consequences were duplicate metadata identity, failed or ambiguous upserts, and invalid participation discriminants entering through a future write path that bypassed application validation.

The deterministic controls remain the canonical PostgreSQL constraints plus principal-scoped calendar mutation. Bootstrap and the checked-in migration now establish missing legacy timestamp columns before altering or backfilling them, enforce the canonical timestamp nullability, then complete the existing transactional deduplication and unique-index creation. The join-mode repair uses one valid named anonymous-block delimiter and installs the existing nullable enum check idempotently. No route, principal, permission, provider, model authority, data class, or user-visible contract changes. Security result: no new finding. Rollback is the merged PR revert; the additive timestamp columns and constraints may remain safely if source rollback is required.

## 11.15 Production process supervision and exit evidence, July 22, 2026

The affected assets are service availability, active user work, and bounded operational metadata across the Railway container, Tini, process supervisor, application child, PostgreSQL, and provider restart boundaries. The production image previously built `dist/process-wrapper.mjs` but launched `dist/index.mjs` directly, bypassing the only component designed to observe child PID, boot identity, exit code, signal, and restart decisions. Independent from the original death cause, that gap made an application-child failure indistinguishable from whole-container disappearance and prevented the existing watchdog contracts from owning recovery.

**Closed in source.** Tini remains PID 1. The shell and package production entrypoints now execute the built supervisor, which launches only `dist/index.mjs`, forwards SIGTERM/SIGINT, preserves child stdout/stderr and IPC, applies the existing health/watchdog predicates, and bounds same-container restart attempts with exponential backoff before exiting non-zero to Railway. One structured `process_lifecycle` envelope records wrapper identity, child PID/path/boot, observed code/signal, clean-versus-unclean termination, and restart decision/count. `runtime-process-lifecycle.ts` stores one fenced current/previous boot record per provider-issued environment/service/replica runtime key in the existing global `system_settings` operational store. `server/index.ts` is the sole application signal coordinator: it stops admission, timers, and executor supervision; aborts active Agent work through its existing owner; drains HTTP/browser work within a fixed budget; records clean termination; closes PostgreSQL pools; and exits. Memory-pressure shutdown reuses this coordinator while retaining its explicit non-zero cause.

**Threat and controls.** The credible threats are denial of service from restart loops or false watchdog kills, spoofed or stale lifecycle evidence, secret disclosure through logs, and a stale child marking a newer boot clean. Controls are one wrapper mutation boundary, boot-ID-fenced terminal writes, provider-issued correlation IDs, positive-field structured logs that contain no user content or credential values, bounded restart/shutdown budgets, and the existing logger retention/redaction boundary. STRIDE mapping: denial of service, spoofing, and repudiation. Control owners: Engineering and Platform.

**Supervisor health authority.** The wrapper's deep DB/pool probe crosses one bounded parent-to-child trust boundary over loopback. The wrapper generates a new 256-bit capability for each child generation, passes it only through that child's environment, the child consumes and deletes the environment value at module load, and the wrapper authenticates the exact `GET /api/health/supervisor` request with a dedicated header. API policy allows only that exact method and path to reach route-owned loopback and constant-time capability validation; a non-loopback request or missing/invalid capability returns 404 before the database probe runs. The authenticated `/api/health/deep` operator route and the personal `/api/health/*` prefix remain unchanged. Both authorized routes call one response producer and expose only S1 operational metadata: boot ID, uptime, memory totals, bounded database-probe result, and pool counts/saturation reasons. No user, account, session, memory, contact, finance, health, email, or other personal data is read. Healthy polls are excluded from response-body access logs, in-flight wedge accounting, and API performance samples; their successful GET line remains debug-only and suppressed in normal production logging. Degraded and failed probes remain visible through the wrapper's warning/error paths. The credible threats are capability spoofing, health-metadata disclosure, false-kill denial of service, and capability leakage through logs. Deterministic controls are loopback-only transport, per-generation entropy, exact route/method classification, default-deny route validation, constant-time comparison, no capability logging, bounded timeouts, and the unchanged heartbeat-plus-stdout liveness predicate plus independent three-probe pool escalation. STRIDE mapping: spoofing, information disclosure, denial of service, and repudiation. Control owners: Engineering and Platform.

**Residual provider boundary.** A process with same-container environment or memory access can recover the capability, but already has equivalent or greater runtime authority; the capability is not a defense against a compromised container. In-process code cannot observe or prove whole-container SIGKILL, kernel/provider OOM eviction, host migration, native termination that kills the wrapper, or another provider stop after the fact. A next boot records an active predecessor without matching supervisor evidence only as `unclean` with unknown cause. Railway documentation states that deployment replacement sends SIGTERM then SIGKILL after `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, whose default is zero, and that deployment health checks do not continuously monitor a live service. Provider draining time, restart policy, metrics, and instance events remain Platform-owned evidence. Rollback is under five minutes by reverting the merged PR or restoring the prior wrapper health path; no destructive schema migration is required.

## 11.16 Dynamic application heap budget, July 22, 2026

**SEC-2026-034, high, closed in source.** Production runtime evidence confirmed an A08 availability failure at B11/B12: concurrent large-context Agent runs drove the application child into V8 heap exhaustion during `JSON.stringify`, briefly returning 502 responses and interrupting active work. The supervisor had hard-coded `--max-old-space-size=2048`, so a larger Railway instance could not use its available memory. Allocating the entire container to V8 would create a second failure mode because Buffers, native modules, worker stacks, code space, child-process overhead, and the OS consume memory outside old space.

The canonical control remains `server/process-wrapper.ts`. Before each application-child start, the wrapper reads the Linux cgroup v2 or v1 memory limit, bounds it by host memory, assigns 75% to V8 old space, and passes the resolved MiB value directly on the `dist/index.mjs` Node command line. The direct argument overrides ambient `NODE_OPTIONS` without granting the same large heap to descendant Node processes. The remaining 25% is explicit native and co-resident headroom. The existing Railway service-instance RSS watchdog still exits gracefully at 90% of the provider limit, preserving restart evidence and active-work recovery. `/api/health/deep` reports V8's actual `heap_size_limit` rather than parsing or assuming a flag value, and `child_started` logs the resolved heap, available memory, percentage, and cgroup source.

Controls: AGENT-04, EXEC-03, OBS-02, REC-02; OWASP API4 and LLM10 unbounded consumption. Owner: Agent Runtime Owner with Application and Platform Owner. Closure evidence: production OOM logs from deployment `568e4260-7c9d-46f1-9ec0-de1f1d522faa`, `server/process-wrapper.ts`, `server/routes/setup.ts`, impact review, production build, and merged PR. Residual risk: raising the ceiling does not cure an unbounded producer; oversized serialization and concurrency remain separately observable and should be reduced at their canonical producers. Rollback is the merged PR revert; no schema or live data mutation is involved.

**Post-deployment evidence preservation.** Two optional inference-payload capture writes later failed at a nested `SAVEPOINT sp1`, but the catch boundary retained only Drizzle's wrapper message and discarded the PostgreSQL cause needed to distinguish stale transaction context, concurrent transaction use, or an already-aborted transaction. The capture boundary now records a bounded allowlist from up to five nested causes: error name/message, SQLSTATE code, severity, detail, hint, position, internal position/query, server where, schema/table/column/data type/constraint, server file/line, and routine. It also records provider, boundary, model, activity, session, attempt, and the boolean presence of an ambient database transaction. Stacks, query parameters, captured requests, credentials, and arbitrary error fields remain excluded. Capture remains fail-open and recovered failure is warning-level. This change improves OBS-02 evidence only; it deliberately does not alter transaction routing before the failure state is proven.

## 11.17 Principal-scoped DOCX attachment reads, July 22, 2026

Uploaded DOCX files are A02/S2 data crossing F07/B07 and B10 from private object storage into a model-invoked read tool. The prior DOCX reader accepted only workspace paths, so canonical attachment paths failed even when upload and ACL state were valid. A naive repair using public URLs or direct raw storage keys would create an IDOR and disclosure risk.

**Closed in source.** `docx.read` now discriminates exact `/objects/...` entity paths from workspace paths. Object-backed reads require the current authenticated user principal, resolve through `ObjectStorageService`, enforce the existing object ACL with `ObjectPermission.READ`, cap the compressed input at 25 MB and declared uncompressed archive content at 100 MB, and parse the authorized buffer directly. Missing principal, foreign object, absent ACL, missing object, and oversized document all fail closed. No public URL, raw S3 key, temporary private copy, new route, provider, permission, or data class is introduced. Workspace reads and all DOCX write/edit/clone behavior remain unchanged. Controls: DATA-01, DATA-04, ING-01, AGENT-03. Security result: no open finding. Rollback is the merged PR revert; no schema or data mutation is involved.
