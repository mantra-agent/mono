# Mantra Security Doctrine and Threat Model

**Status:** Canonical security baseline<br>
**Baseline date:** 2026-07-20<br>
**Source reviewed:** `mantra-agent/mono` at `76382b6`<br>
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

### Preserved controls and residual risk

The Claude SDK keeps built-in Bash/file/web/task tools disabled and exposes only Mantra MCP definitions. Tool-call idempotency remains `(runId, toolCallId)` scoped; write ordering, plan/workflow terminal ownership, admission budgets, session spawn idempotency, session chain-depth caps, principal-scoped vNext retrieval, bounded tool-output artifacts, and human-only Gmail sending remain in force.

Residual medium risks are tracked for later application/platform review: domain-specific URL adapters and provider callbacks need complete egress/replay verification; the bridge monolith still has uneven action schemas and some tools default conservatively to external-effect; hook names remain globally unique, which is a tenancy usability constraint rather than an authority bypass; shell allowlisting is intentionally narrow and may require explicit expansion as trusted engineering workflows evolve. No known unowned critical/high finding remains in the audited agent-authority plane.
