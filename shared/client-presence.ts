export type ClientPresenceKind = "web" | "ios" | "glasses";

export interface ClientPresenceEntry {
  id: string;
  kind: ClientPresenceKind;
  connectedAt: string;
  lastSeenAt: string;
}

export interface ClientPresenceSnapshot {
  clients: ClientPresenceEntry[];
}

export function isClientPresenceKind(value: unknown): value is ClientPresenceKind {
  return value === "web" || value === "ios" || value === "glasses";
}
