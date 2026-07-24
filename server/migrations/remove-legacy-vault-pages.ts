// RETIRED 2026-07-23 — legacy Library Vault repair migration removed.
//
// This migration attempted to reconcile duplicate canonical Index pages and
// relocate legacy vault marker pages via a chain of exact-match / full-row
// compare-and-swap guards and a physical move of protected Index structure.
// It failed on every live boot (raw-array binding, NULL comparison, then a
// protected-Index move the move guard correctly forbids), leaving the repair
// aborted before it did any useful work.
//
// The legitimate convergence it was chasing is already owned, idempotently and
// under an advisory lock, by ensureCanonicalVaultMetadataPage() in
// server/library-domain.ts: the earliest root metadata page stays canonical and
// any duplicate is demoted to an ordinary artifact. That runtime path resolved
// the production corruption directly. This module is intentionally a no-op
// tombstone (no imports, no runtime effect) and is safe to hard-delete.
export {};
