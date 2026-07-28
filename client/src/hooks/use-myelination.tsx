// Retired: legacy memory myelination UI hook and provider.
//
// The `/api/memory/myelinate` and `/api/memory/myelination/*` endpoints were
// removed when memory HTTP routes became vNext-only. This module previously
// hosted `MyelinationProvider` / `useMyelination`; all callers were removed in
// the Phase 2 legacy-runtime retirement. Intentionally left as an empty module
// with no exports so nothing references retired legacy-memory endpoints.
export {};
