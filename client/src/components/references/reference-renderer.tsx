import type { ReferenceRef } from "@shared/references";
import type { LucideIcon } from "lucide-react";
import { ReferenceChip } from "./reference-chip";
import { resolveReference } from "./reference-registry";
import { useOptionalVaults } from "@/hooks/use-vaults";
import { vaultReferenceColor } from "@/lib/vault-title-color";

export type ReferenceSurface = "chat-inline" | "simple-chip" | "simple-row" | "card" | "expanded";

const SURFACE_CLASSES: Record<ReferenceSurface, string | undefined> = {
  "chat-inline": undefined,
  "simple-chip": "text-xs leading-tight",
  "simple-row": "text-xs leading-tight",
  "card": "text-sm leading-tight",
  "expanded": undefined,
};

export function ReferenceRenderer({
  refValue,
  surface = "chat-inline",
  className,
  IconOverride,
  iconClassName,
  wrapLabel = false,
  iconOnly = false,
}: {
  refValue: ReferenceRef;
  surface?: ReferenceSurface;
  className?: string;
  IconOverride?: LucideIcon;
  iconClassName?: string;
  /** Allow multi-line labels for tree/row titles. */
  wrapLabel?: boolean;
  /** Icon-only chip for dense surfaces; label stays in tooltip/aria-label. */
  iconOnly?: boolean;
}) {
  const vaultContext = useOptionalVaults();
  const vaults = vaultContext?.vaults ?? [];
  const activeVaultId = vaultContext?.activeVaultId ?? null;
  const vaultById = new Map(vaults.map(vault => [vault.id, vault]));
  const vaultIds = Array.isArray(refValue.metadata?.vaultIds)
    ? refValue.metadata.vaultIds.filter((id): id is string => typeof id === "string")
    : undefined;
  const usesVaultColor = (surface === "simple-chip" || surface === "simple-row")
    && ["project", "milestone", "task", "meeting", "goal"].includes(refValue.type);
  const color = usesVaultColor
    ? vaultReferenceColor(vaultIds, vaultById, activeVaultId)
    : null;

  return (
    <ReferenceChip
      resolved={resolveReference(refValue)}
      className={[SURFACE_CLASSES[surface], className].filter(Boolean).join(" ")}
      IconOverride={IconOverride}
      iconClassName={iconClassName}
      color={color}
      wrapLabel={wrapLabel}
      iconOnly={iconOnly}
    />
  );
}
