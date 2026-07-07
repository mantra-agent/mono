import { Glasses, Globe2, Smartphone } from "lucide-react";
import { useMemo } from "react";
import { useClientPresence } from "@/hooks/use-client-presence";
import type { ClientPresenceEntry, ClientPresenceKind } from "@shared/client-presence";

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

export function ConnectionsIndicator() {
  const { clients } = useClientPresence();
  const orderedKinds = useMemo(
    () => Array.from(new Set(clients.map((client) => client.kind))).sort(kindSort),
    [clients],
  );

  if (orderedKinds.length === 0) return null;

  const label = orderedKinds
    .map((kind) => KIND_LABEL[kind].replace(" connected", ""))
    .join(", ");

  return (
    <div
      className="flex flex-row-reverse items-center gap-1"
      aria-label={`Connected clients: ${label}`}
      data-testid="connections-indicator"
    >
      {orderedKinds.map((kind) => (
        <span
          key={kind}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground bg-background/80"
          title={KIND_LABEL[kind]}
          data-testid={`connection-icon-${kind}`}
        >
          <PresenceIcon kind={kind} />
        </span>
      ))}
    </div>
  );
}
