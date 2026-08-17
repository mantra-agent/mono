import { Glasses, Globe2, Smartphone } from "lucide-react";
import { useMemo } from "react";
import { useClientPresence } from "@/hooks/use-client-presence";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ClientPresenceKind } from "@shared/client-presence";

const KIND_LABEL: Record<ClientPresenceKind, string> = {
  web: "Web connected",
  ios: "iOS connected",
  glasses: "Glasses connected",
};

function PresenceIcon({ kind }: { kind: ClientPresenceKind }) {
  const className = "h-3.5 w-3.5";
  if (kind === "ios") return <Smartphone className={className} />;
  if (kind === "glasses") return <Glasses className={className} />;
  return <Globe2 className={className} />;
}

function kindSort(a: ClientPresenceKind, b: ClientPresenceKind): number {
  const order: Record<ClientPresenceKind, number> = { web: 0, ios: 1, glasses: 2 };
  return order[a] - order[b];
}

interface ConnectionsIndicatorProps {
  /** When no clients are present, render this quiet label instead of hiding. */
  emptyText?: string;
  className?: string;
}

export function ConnectionsIndicator({ emptyText, className }: ConnectionsIndicatorProps = {}) {
  const { clients } = useClientPresence();
  const orderedKinds = useMemo(
    () => Array.from(new Set(clients.map((client) => client.kind))).sort(kindSort),
    [clients],
  );

  if (orderedKinds.length === 0) {
    if (!emptyText) return null;
    return (
      <span
        className={cn("text-xs text-muted-foreground", className)}
        data-testid="connections-indicator-empty"
      >
        {emptyText}
      </span>
    );
  }

  const label = orderedKinds
    .map((kind) => KIND_LABEL[kind].replace(" connected", ""))
    .join(", ");

  return (
    <div
      className={cn("flex items-center gap-1", className)}
      aria-label={`Connected clients: ${label}`}
      data-testid="connections-indicator"
    >
      {orderedKinds.map((kind) => (
        <Tooltip key={kind}>
          <TooltipTrigger asChild>
            <span
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground bg-background/80"
              data-testid={`connection-icon-${kind}`}
            >
              <PresenceIcon kind={kind} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{KIND_LABEL[kind]}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
