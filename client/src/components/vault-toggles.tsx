/**
 * @deprecated Replaced by `VaultSwitcher` (./vault-switcher.tsx) on 2026-07-24.
 *
 * This file is intentionally reduced to a re-export shim. The single-button
 * vault switcher supersedes the old toggle row; no consumer imports
 * `VaultToggles` anymore. Kept only because file deletion is not available to
 * the agent tooling — safe to delete outright.
 */
export { VaultSwitcher as VaultToggles } from "./vault-switcher";
