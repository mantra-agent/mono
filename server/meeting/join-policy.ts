import type { CalendarEvent } from "../google-calendar";
import { getSetting, setSetting } from "../system-settings";

export const MEETING_JOIN_POLICIES = [
  "all",
  "only_toggled",
  "exclude_external",
] as const;

export type MeetingJoinPolicy = typeof MEETING_JOIN_POLICIES[number];

export const DEFAULT_MEETING_JOIN_POLICY: MeetingJoinPolicy = "only_toggled";

function settingKey(userId: string): string {
  return `user:${userId}:meeting.join_policy`;
}

export function isMeetingJoinPolicy(value: unknown): value is MeetingJoinPolicy {
  return typeof value === "string" && MEETING_JOIN_POLICIES.includes(value as MeetingJoinPolicy);
}

export async function getMeetingJoinPolicy(userId: string): Promise<MeetingJoinPolicy> {
  const stored = await getSetting<unknown>(settingKey(userId));
  return isMeetingJoinPolicy(stored) ? stored : DEFAULT_MEETING_JOIN_POLICY;
}

export async function setMeetingJoinPolicy(userId: string, policy: MeetingJoinPolicy): Promise<void> {
  await setSetting(settingKey(userId), policy);
}

function domain(email: string | undefined): string | null {
  const value = email?.trim().toLowerCase();
  if (!value) return null;
  const separator = value.lastIndexOf("@");
  return separator >= 0 ? value.slice(separator + 1) || null : null;
}

export function hasExternalAttendees(event: CalendarEvent): boolean {
  const accountDomain = domain(event.accountEmail);
  if (!accountDomain) return false;
  return event.attendees.some((attendee) => {
    if (attendee.self) return false;
    const attendeeDomain = domain(attendee.email);
    return attendeeDomain !== null && attendeeDomain !== accountDomain;
  });
}

export function shouldJoinMeeting(
  event: CalendarEvent,
  policy: MeetingJoinPolicy,
  override: boolean | null | undefined,
): boolean {
  if (override !== null && override !== undefined) return override;
  if (policy === "only_toggled") return false;
  if (policy === "exclude_external") return !hasExternalAttendees(event);
  return true;
}
