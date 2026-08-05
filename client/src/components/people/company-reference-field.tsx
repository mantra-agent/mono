// Retired 2026-08-04. The Company selector now uses the shared ReferencePicker
// (mode="single", types={["company"]}, allowCreate, onCreate) at its single
// call site in client/src/pages/people.tsx. Bespoke company-only picker removed
// to keep reference selection on one canonical control. Kept as a tombstone
// because the toolchain cannot delete files in-session; safe to delete on next
// cleanup pass — nothing imports this module.
export {};
