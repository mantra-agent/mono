const SESSION_REMINDER_PREFIX = "session-reminder:";

export function buildSessionReminderDescription(sessionId: string): string {
  return `${SESSION_REMINDER_PREFIX}${sessionId}`;
}

export function buildSessionReminderName(sessionTitle: string, sessionId: string): string {
  const title = sessionTitle.trim();
  return title || `Session Reminder (${sessionId})`;
}

export function extractSessionReminderId(description: string): string | null {
  if (!description.startsWith(SESSION_REMINDER_PREFIX)) return null;
  const sessionId = description.slice(SESSION_REMINDER_PREFIX.length).trim();
  return sessionId || null;
}
