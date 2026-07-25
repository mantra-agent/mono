import { useState } from "react";
import { useVaults } from "@/hooks/use-vaults";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";

const log = createLogger("VaultSwitcher");

/** Cap on the number of colored dots shown before collapsing to "+N". */
const DOT_CAP = 5;
/** Neutral fallback when a vault has no stored color. */
const FALLBACK_COLOR = "hsl(var(--muted-foreground))";

/**
 * Top-bar vault control: one button that IS the active vault.
 *
 * - Button body shows the active vault's name in its vault color.
 * - A row of small colored dots along the bottom represents the OTHER visible
 *   vaults (one dot each, in vault color). Pure indicators; the whole button
 *   opens the dropdown.
 * - The dropdown lists every vault. Clicking a name activates it (and reveals
 *   it) and closes; flipping a toggle shows/hides it and stays open.
 *
 * Invariant (enforced in useVaults): active ⟹ visible. The active vault's
 * toggle is locked on; the only way to stop seeing it is to activate another.
 */
export function VaultSwitcher() {
  const {
    vaults,
    activeVaultId,
    toggleVault,
    setActiveVault,
    isVisible,
    isLoading,
  } = useVaults();
  const [open, setOpen] = useState(false);

  // Nothing to switch between until loaded or with a single vault.
  if (isLoading || vaults.length <= 1) return null;

  const activeVault = vaults.find((v) => v.id === activeVaultId) ?? vaults[0];
  const otherVisible = vaults.filter(
    (v) => v.id !== activeVault.id && isVisible(v.id),
  );
  const shownDots = otherVisible.slice(0, DOT_CAP);
  const overflow = otherVisible.length - shownDots.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex flex-col items-center justify-center gap-0.5 rounded-md px-2 py-1 transition-colors hover:bg-muted/50"
          aria-label={`Active vault: ${activeVault.name}${
            otherVisible.length > 0
              ? `, ${otherVisible.length} other vault${otherVisible.length === 1 ? "" : "s"} visible`
              : ""
          }`}
          data-testid="vault-switcher-trigger"
        >
          <span
            className="max-w-[140px] truncate text-xs font-medium"
            style={{ color: activeVault.color ?? FALLBACK_COLOR }}
          >
            {activeVault.name}
          </span>
          {(shownDots.length > 0 || overflow > 0) && (
            <span
              className="flex items-center gap-0.5"
              aria-hidden="true"
            >
              {shownDots.map((v) => (
                <span
                  key={v.id}
                  className="h-1 w-1 rounded-full"
                  style={{ backgroundColor: v.color ?? FALLBACK_COLOR }}
                />
              ))}
              {overflow > 0 && (
                <span className="text-2xs leading-none text-muted-foreground">
                  +{overflow}
                </span>
              )}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" sideOffset={6} className="w-56 p-1">
        {vaults.map((vault) => {
          const active = vault.id === activeVault.id;
          const visible = isVisible(vault.id);

          return (
            <div
              key={vault.id}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5",
                active && "bg-accent",
              )}
              data-testid={`vault-switcher-row-${vault.id}`}
            >
              <button
                type="button"
                onClick={() => {
                  if (active) return;
                  log.debug("set active vault", { vaultId: vault.id, name: vault.name });
                  setActiveVault(vault.id);
                  setOpen(false);
                }}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-label={`Make ${vault.name} the active vault`}
                data-testid={`vault-switcher-name-${vault.id}`}
              >
                <span
                  className="truncate text-sm"
                  style={{ color: vault.color ?? FALLBACK_COLOR }}
                >
                  {vault.name}
                </span>
                {active && (
                  <span className="ml-auto shrink-0 text-2xs uppercase tracking-wider text-muted-foreground">
                    Active
                  </span>
                )}
              </button>
              <Switch
                checked={visible}
                disabled={active}
                onCheckedChange={() => {
                  log.debug("vault visibility toggle", {
                    vaultId: vault.id,
                    name: vault.name,
                    wasVisible: visible,
                  });
                  toggleVault(vault.id);
                }}
                aria-label={`${vault.name} visibility${active ? " (locked on — active vault)" : ""}`}
                data-testid={`vault-switcher-toggle-${vault.id}`}
              />
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
