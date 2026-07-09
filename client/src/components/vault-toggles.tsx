import { useVaults } from "@/hooks/use-vaults";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";

const log = createLogger("VaultToggles");

/**
 * Top-bar vault toggle row. Each vault renders as a small pill/button.
 * Click toggles visibility. Right-click (context menu) to set active.
 * Active vault has a distinguishing ring and cannot be toggled off.
 */
export function VaultToggles() {
  const { vaults, activeVaultId, toggleVault, setActiveVault, isVisible, isLoading } = useVaults();

  // Don't render toggles until loaded, or if only one vault (no toggling needed)
  if (isLoading || vaults.length <= 1) return null;

  return (
    <div className="flex items-center gap-1.5" data-testid="vault-toggles">
      {vaults.map((vault) => {
        const active = vault.id === activeVaultId;
        const visible = isVisible(vault.id);
        const abbr = vault.icon || vault.name.slice(0, 1).toUpperCase();

        return (
          <ContextMenu key={vault.id}>
            <Tooltip>
              <TooltipTrigger asChild>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      log.debug("vault toggle clicked", { vaultId: vault.id, name: vault.name, wasVisible: visible });
                      toggleVault(vault.id);
                    }}
                    className={cn(
                      "shrink-0 flex items-center justify-center h-7 w-7 rounded-md border text-xs font-medium transition-all duration-150",
                      visible
                        ? "bg-muted/50 text-foreground border-foreground/20 hover:bg-muted/70"
                        : "text-muted-foreground/40 border-border/50 hover:bg-muted/30",
                      active && "ring-1 ring-active ring-offset-1 ring-offset-background",
                    )}
                    aria-label={`${vault.name} vault${active ? " (active)" : ""}${visible ? "" : " (hidden)"}`}
                    aria-pressed={visible}
                    data-testid={`vault-toggle-${vault.id}`}
                  >
                    {abbr}
                  </button>
                </ContextMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                <p>{vault.name}{active ? " (active)" : ""}</p>
                <p className="text-muted-foreground">Click to toggle · Right-click to set active</p>
              </TooltipContent>
            </Tooltip>
            <ContextMenuContent>
              <ContextMenuItem
                disabled={active}
                onClick={() => {
                  log.debug("set active vault via context menu", { vaultId: vault.id });
                  setActiveVault(vault.id);
                }}
              >
                {active ? "Already active" : `Set "${vault.name}" as active`}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}
