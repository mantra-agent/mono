/**
 * Canonical glass treatment for toast, tooltip, and modal decision surfaces.
 *
 * Sheen layers (`before` / `after`) must paint *under* content. They use
 * negative z-index inside an isolated stacking context so every consumer —
 * Dialog, AlertDialog, Sheet, Drawer, toast, and custom modals — keeps text
 * and controls readable without per-child `z-10` wrappers.
 */
export const GLASS_SURFACE_CLASS =
  "relative isolate overflow-hidden rounded-2xl border border-white/20 bg-gradient-to-br from-zinc-900/94 via-zinc-800/88 to-zinc-950/96 text-white shadow-[0_18px_60px_rgba(0,0,0,0.58),0_0_0_1px_rgba(255,255,255,0.08),inset_0_1px_0_rgba(255,255,255,0.22)] backdrop-blur-xl before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:-z-10 before:h-1/2 before:bg-gradient-to-b before:from-white/14 before:via-white/6 before:to-transparent after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.12),transparent_58%)]";

export const TOAST_GLASS_SURFACE_CLASS = GLASS_SURFACE_CLASS;
export const MODAL_GLASS_SURFACE_CLASS = GLASS_SURFACE_CLASS;
