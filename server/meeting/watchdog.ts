import { createLogger } from "../log";
import {
  autoLogMeetingInteractions,
  classifyEventByTitle,
  getLinkedPeople,
  setMetadata,
} from "../calendar-metadata";
import { listAllEvents } from "../google-calendar";
import { createUserPrincipalFromUser, resolveUserIdentityFoundation } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { storage } from "../storage";

const log = createLogger("meeting-watchdog");

export interface MeetingWatchdogResult {
  ownersScanned: number;
  eventsScanned: number;
  metadataCreated: number;
  interactionsLogged: number;
  errors: string[];
}

async function processOwnerMeetings(
  user: Awaited<ReturnType<typeof storage.getUsers>>[number],
  now: Date,
): Promise<Omit<MeetingWatchdogResult, "ownersScanned">> {
  const foundation = await resolveUserIdentityFoundation(user.id);
  const principal = createUserPrincipalFromUser(user, foundation.accountId);

  return runWithPrincipal(principal, async () => {
    const lookback = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const { events, errors: accountErrors } = await listAllEvents({
      timeMin: lookback.toISOString(),
      timeMax: now.toISOString(),
    });
    const errors = accountErrors.map(
      (error) => `${error.accountId}: ${error.message}`,
    );

    const endedWithAttendees = events.filter((event) => {
      const endTime = event.end?.dateTime || event.end?.date;
      if (!endTime || new Date(endTime) > now) return false;
      return (event.attendees || []).some(
        (attendee) => !attendee.self && attendee.email,
      );
    });

    let metadataCreated = 0;
    let interactionsLogged = 0;
    for (const event of endedWithAttendees) {
      try {
        const attendeeEmails = (event.attendees || [])
          .filter((attendee) => !attendee.self && attendee.email)
          .map((attendee) => attendee.email);
        const eventType = classifyEventByTitle(event.summary) || "meeting";
        const eventDate = (
          event.start?.dateTime ||
          event.start?.date ||
          ""
        ).slice(0, 10);
        const metadata = await setMetadata(
          event.id,
          event.accountId,
          event.calendarId,
          eventType,
          undefined,
          attendeeEmails,
        );
        metadataCreated++;

        const people = await getLinkedPeople(metadata.id);
        if (people.length > 0) {
          const results = await autoLogMeetingInteractions(
            people,
            event.summary || "Meeting",
            eventDate,
          );
          interactionsLogged += results.filter((result) => result.logged).length;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${event.id}: ${message}`);
        log.warn("Failed processing ended meeting", {
          ownerUserId: user.id,
          eventId: event.id,
          title: event.summary,
          error: message,
        });
      }
    }

    return {
      eventsScanned: endedWithAttendees.length,
      metadataCreated,
      interactionsLogged,
      errors,
    };
  });
}

/**
 * Scan recently ended meetings one owner at a time. The scheduler may enumerate
 * users globally, but connected accounts and every sensitive read/write remain
 * inside the exact owner's principal.
 */
export async function runMeetingWatchdog(): Promise<MeetingWatchdogResult> {
  const result: MeetingWatchdogResult = {
    ownersScanned: 0,
    eventsScanned: 0,
    metadataCreated: 0,
    interactionsLogged: 0,
    errors: [],
  };

  const users = await storage.getUsers();
  for (const user of users) {
    try {
      const ownerResult = await processOwnerMeetings(user, new Date());
      result.ownersScanned++;
      result.eventsScanned += ownerResult.eventsScanned;
      result.metadataCreated += ownerResult.metadataCreated;
      result.interactionsLogged += ownerResult.interactionsLogged;
      result.errors.push(...ownerResult.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${user.id}: ${message}`);
      log.error("Owner-scoped meeting watchdog failed", {
        ownerUserId: user.id,
        error: message,
      });
    }
  }

  log.info("Meeting watchdog completed", result);
  return result;
}
