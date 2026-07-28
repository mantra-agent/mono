import { eq } from "drizzle-orm";
import type { MeetingRecapMeta, MeetingSessionMeta } from "@shared/models/chat";
import { libraryPages } from "@shared/models/info";
import { db } from "../db";
import { combineWithVisibleScope } from "../scoped-storage";
import type { Principal } from "../principal";
import type { CalendarEvent } from "../google-calendar";
import { formatInTimezone } from "../timezone";
import { stripPrivateAgendaFromRecap } from "./recap-content";

const EMAIL_BODY_CHAR_LIMIT = 30_000;

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

export interface RecapEmailRecipient {
  email: string;
  name?: string;
  personId?: string;
}

export function replaceRecapEntryUrl(body: string, recapEntryUrl: string): string {
  const cta = `[Review and automate your goals with Mantra](${recapEntryUrl})`;
  const withoutLegacyFooter = body.replace(
    /\n{0,2}Sent with \[Mantra\]\([^\n)]+\)\s*$/i,
    "",
  );
  const ctaPattern = /\[(?:Open your recap and assigned work|Review and automate your goals with Mantra)\]\([^\n)]+\)/i;
  if (ctaPattern.test(withoutLegacyFooter)) {
    return withoutLegacyFooter.replace(ctaPattern, cta);
  }
  return `${withoutLegacyFooter.trimEnd()}\n\n${cta}`;
}

export async function buildRecapEmailContent(
  recap: MeetingRecapMeta,
  meeting: MeetingSessionMeta,
  attendee: RecapEmailRecipient | undefined,
  event: CalendarEvent | null,
  principal: Principal,
  recapEntryUrl: string | null,
): Promise<string> {
  if (!recap.pageId) throw new Error("Canonical recap page is missing");

  const [page] = await db
    .select({ plainTextContent: libraryPages.plainTextContent })
    .from(libraryPages)
    .where(
      combineWithVisibleScope(
        principal,
        libraryScopeColumns,
        eq(libraryPages.id, recap.pageId),
      ),
    )
    .limit(1);
  const storedRecap = stripPrivateAgendaFromRecap(page?.plainTextContent.trim() ?? "");
  if (!storedRecap) throw new Error(`Canonical recap page ${recap.pageId} has no content`);

  const meetingName = meeting.title?.trim() || recap.pageTitle?.replace(/^Meeting:\s*/i, "").trim() || "Meeting";
  const startedAt = new Date(meeting.startedAt ?? meeting.eventStart ?? event?.start.dateTime ?? event?.start.date ?? "");
  const timeLabel = Number.isNaN(startedAt.getTime())
    ? "Time unavailable"
    : `${formatInTimezone(startedAt, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })} ${formatInTimezone(startedAt, { month: "short", day: "numeric", year: "numeric" })}`;
  const participantLine = meeting.participants
    .map(participant => participant.label.trim())
    .filter((label): label is string => !!label)
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .join(", ");
  const meetingDetails = [
    `- Time: ${timeLabel}`,
    ...(participantLine ? [`- Participants: ${participantLine}`] : []),
  ].join("\n");
  const greetingName = firstName(attendee?.name);
  const greeting = greetingName ? `Hi ${greetingName},` : "Hi,";

  const summary = sectionContent(storedRecap, "Summary");
  if (!summary) throw new Error("Canonical recap summary is missing");
  const sections = [
    { title: "KEY DECISIONS", items: sectionItems(storedRecap, "Key Decisions") },
    { title: "OPEN QUESTIONS", items: sectionItems(storedRecap, "Open Questions") },
    { title: "ACTION ITEMS", items: sectionItems(storedRecap, "Action Items") },
  ].filter(section => section.items.length > 0);

  const blocks = [
    greeting,
    `**${meetingName}**\n${meetingDetails}`,
    summary,
    ...sections.map(section =>
      `**${section.title}**\n${section.items.map(item => `- ${item}`).join("\n")}`,
    ),
    ...(recapEntryUrl
      ? [`[Review and automate your goals with Mantra](${recapEntryUrl})`]
      : []),
  ];
  const body = blocks.join("\n\n");
  if (body.length > EMAIL_BODY_CHAR_LIMIT) {
    throw new Error(`Canonical recap exceeds the ${EMAIL_BODY_CHAR_LIMIT}-character email budget`);
  }
  return body;
}

function sectionContent(markdown: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(
    new RegExp(`^##\\s+${escapedHeading}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s+|$)`, "im"),
  );
  return match?.[1]
    ?.trim()
    .replace(/@person:[A-Za-z0-9_-]+/g, "")
    .replace(/\n{3,}/g, "\n\n") ?? "";
}

function sectionItems(markdown: string, heading: string): string[] {
  const content = sectionContent(markdown, heading);
  if (!content || /^(?:[-*]\s*)?none\.?$/i.test(content.trim())) return [];
  const bulletItems = content
    .split("\n")
    .map(line => line.match(/^[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((item): item is string => !!item && !/^none\.?$/i.test(item));
  return bulletItems.length > 0 ? bulletItems : [content.replace(/\s+/g, " ").trim()];
}

function firstName(name: string | undefined): string | null {
  const normalized = name?.trim();
  if (!normalized) return null;
  return normalized.split(/\s+/)[0] || null;
}
