# Coding Flow Verification

This document is a low-risk sentinel for exercising the Agent coding workflow end to end.

Verification path:

1. Work from an isolated clone under `repos/`.
2. Create a short-lived branch from `main`.
3. Make a documentation-only change with no runtime behavior impact.
4. Run `npm run build` as the required automated gate.
5. Open a PR against `main`.
6. Merge the PR after the build passes, unless review-first or another blocker applies.

Last manual workflow check: 2026-07-07.
