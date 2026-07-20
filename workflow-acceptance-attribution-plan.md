# Workflow Acceptance Attribution Repair

## Failed invariants

1. Acceptance asks whether the newest Railway deployment is green. It must ask whether the currently usable deployment contains the workflow's merged commit. A later failed or building deployment must not shadow an earlier successful deployment that already contains that commit.
2. `platform_binding` acceptance requests authenticated evidence but the external browser context receives no user session. The existing bearer token creates a service principal, while `/api/auth/me` correctly requires a user principal, so 401 is deterministic.

## Design

- Resolve Railway deployment truth from the workflow's expected merged commit. Query the bound environment's bounded deployment history, prioritize successful deployments, and prove exact commit or GitHub ancestry using the bound source repository. If no deployment can be attributed, return an explicit unavailable invariant instead of silently falling back to latest.
- Make publish and acceptance capture request commit-aware environment truth. Record containment attribution in the deployment packet.
- Establish `platform_binding` auth by creating a short-lived PostgreSQL session for the workflow owner and injecting its signed cookie for the bound target origin. Verify `/api/auth/me`. If identity, shared session storage, cookie signing, or target acceptance fails, emit a precise diagnostic naming the violated platform-binding invariant.
- Keep authentication scoped to the workflow owner. Never select an arbitrary admin for workflow acceptance.

## Engineering-principles audit

- Single source of truth: workflow evidence supplies the expected commit; Platform source/hosting bindings supply repository, environment, credentials, and target URL.
- Canonical mutation path: browser session creation remains in BrowserManager; deployment selection remains in workflow environment truth.
- Encode invariants in structure: explicit deployment attribution and explicit browser authentication descriptors replace implicit latest-deployment and boolean-auth behavior.
- Least privilege and ownership: acceptance session uses `workflowRuns.ownerUserId`, never the first admin.
- Bounded operations: inspect at most 25 Railway deployments and stop at the first provably suitable candidate in status-priority order.
- Failure behavior: ancestry/auth uncertainty fails closed with actionable diagnostics. No fallback can produce a false acceptance pass.
- Replayability and cleanup: session rows are short-lived and deleted best-effort after capture.
- Rollback: one server-only PR; revert restores prior behavior with no schema migration or persistent interface change.

## Verification

Run `npm run build`, inspect diff/status, run change-scope detection, merge PR to `main`.
