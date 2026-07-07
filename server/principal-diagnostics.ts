import type { Principal } from "./principal";

export type PrincipalDiagnosticEventType =
  | "attach_user"
  | "attach_service"
  | "auth_denied"
  | "admin_denied"
  | "scope_denied"
  | "privileged_mode_denied"
  | "privileged_mode_granted";

export interface PrincipalDiagnosticEvent {
  type: PrincipalDiagnosticEventType;
  at: string;
  path?: string;
  method?: string;
  reason?: string;
  requiredScope?: string;
  requestedScope?: string;
  principalActorType?: Principal["actorType"];
  principalUserId?: string | null;
  principalAccountId?: string | null;
  isAdmin?: boolean;
}

const MAX_EVENTS = 500;
const events: PrincipalDiagnosticEvent[] = [];
const counts: Record<PrincipalDiagnosticEventType, number> = {
  attach_user: 0,
  attach_service: 0,
  auth_denied: 0,
  admin_denied: 0,
  scope_denied: 0,
  privileged_mode_denied: 0,
  privileged_mode_granted: 0,
};

export function recordPrincipalDiagnosticEvent(event: Omit<PrincipalDiagnosticEvent, "at">): void {
  counts[event.type] += 1;
  events.push({ ...event, at: new Date().toISOString() });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function getPrincipalDiagnosticSnapshot(limit = 100) {
  return {
    retainedEvents: events.length,
    maxEvents: MAX_EVENTS,
    counts: { ...counts },
    recent: events.slice(-Math.max(0, Math.min(limit, MAX_EVENTS))).reverse(),
  };
}
