interface EventSocketRecord {
  connectedAt: number;
  sessionIds: Set<string>;
}

const eventSockets = new Map<string, EventSocketRecord>();
let peakEventSockets = 0;
let peakSessionSockets = 0;
let peakSessionSocketLinks = 0;
let connectionsOpened = 0;
let connectionsClosed = 0;
let abnormalDisconnects = 0;

function currentCounts() {
  let sessionSockets = 0;
  let sessionSocketLinks = 0;
  const uniqueSessionIds = new Set<string>();
  for (const socket of eventSockets.values()) {
    if (socket.sessionIds.size > 0) sessionSockets++;
    sessionSocketLinks += socket.sessionIds.size;
    socket.sessionIds.forEach((sessionId) => uniqueSessionIds.add(sessionId));
  }
  return { sessionSockets, sessionSocketLinks, uniqueSubscribedSessions: uniqueSessionIds.size };
}

function updatePeaks(): void {
  const current = currentCounts();
  peakEventSockets = Math.max(peakEventSockets, eventSockets.size);
  peakSessionSockets = Math.max(peakSessionSockets, current.sessionSockets);
  peakSessionSocketLinks = Math.max(peakSessionSocketLinks, current.sessionSocketLinks);
}

export function registerEventSocket(connectionId: string): void {
  if (eventSockets.has(connectionId)) return;
  eventSockets.set(connectionId, { connectedAt: Date.now(), sessionIds: new Set() });
  connectionsOpened++;
  updatePeaks();
}

export function setEventSocketSessionSubscription(
  connectionId: string,
  sessionId: string,
  subscribed: boolean,
): void {
  const socket = eventSockets.get(connectionId);
  if (!socket) return;
  if (subscribed) socket.sessionIds.add(sessionId);
  else socket.sessionIds.delete(sessionId);
  updatePeaks();
}

export function unregisterEventSocket(connectionId: string, closeCode: number): void {
  if (!eventSockets.delete(connectionId)) return;
  connectionsClosed++;
  if (closeCode !== 1000 && closeCode !== 1001) abnormalDisconnects++;
}

export function getRealtimeTransportMetrics() {
  const now = Date.now();
  const current = currentCounts();
  const oldestEventSocketAgeMs = eventSockets.size > 0
    ? Math.max(...Array.from(eventSockets.values(), (socket) => now - socket.connectedAt))
    : 0;
  return {
    eventSockets: eventSockets.size,
    peakEventSockets,
    sessionSockets: current.sessionSockets,
    peakSessionSockets,
    sessionSocketLinks: current.sessionSocketLinks,
    peakSessionSocketLinks,
    uniqueSubscribedSessions: current.uniqueSubscribedSessions,
    oldestEventSocketAgeMs,
    connectionsOpened,
    connectionsClosed,
    abnormalDisconnects,
  };
}
