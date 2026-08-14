import { createLogger } from "../log";
import {
  autoLogMeetingInteractions,
  classifyEventByTitle,
  getLinkedPeople,
  setMetadata,
} from "../calendar-metadata";
import { listAllEvents } from "../google-calendar";
import {
  AccountLifecycleError,
  createUserPrincipalFromUser,
  listUsersWithIdentityFoundation,
  type UserIdentityFoundation,
} from "../principal";
import { runWithPrincipal } from "../principal-context";
import type { User } from "@shared/schema";

const log = createLogger("meeting-watchdog");

export interface MeetingWatchdogResult {
  ownersScanned: number;
  ownersSkipped: number;
  eventsScanned: number;
  metadataCreated: number;
  interactionsLogged: number;
  errors: string[];
}

type MeetingWatchdogOperation =
  | "process_owner"
  | "process_event"
  | "list_events";

type MeetingWatchdogOperationError = Error & {
  code?: string;
  operation?: MeetingWatchdogOperation;
  ownerUserId?: string;
  eventId?: string;
  accountId?: string;
  phase?: "owner" | "event" | "account_list";
  errorCount?: number;
};

function normalizeMeetingWatchdogError(
  value: unknown,
  operation: MeetingWatchdogOperation,
  fallbackCode: string,
  message?: string,
): MeetingWatchdogOperationError {
  let error: MeetingWatchdogOperationError;
  if (value instanceof Error) {
    error = value as MeetingWatchdogOperationError;
  } else if (typeof value === "string" && value.trim()) {
    error = new Error(message || value) as MeetingWatchdogOperationError;
  } else {
    error = new Error(message || "Meeting watchdog operation failed", {
      cause: value,
    }) as MeetingWatchdogOperationError;
  }
  if (!error.code || !/^[A-Z][A-Z0-9_]{1,47}$/.test(String(error.code))) {
    error.code = fallbackCode;
  }
  error.operation = operation;
  return error;
}

function meetingWatchdogLogContext(options: {
  operation: MeetingWatchdogOperation;
  ownerUserId?: string;
  eventId?: string;
  accountId?: string;
  phase?: "owner" | "event" | "account_list";
  errorCount?: number;
  eventsScanned?: number;
  metadataCreated?: number;
  interactionsLogged?: number;
}) {
  return {
    operation: options.operation,
    ownerUserId: options.ownerUserId,
    eventId: options.eventId,
    accountId: options.accountId,
    phase: options.phase,
    errorCount: options.errorCount,
    eventsScanned: options.eventsScanned,
    metadataCreated: options.metadataCreated,
    interactionsLogged: options.interactionsLogged,
  };
}

async function processOwnerMeetings(
  user: User,
  foundation: UserIdentityFoundation,
  now: Date,
): Promise<Omit<MeetingWatchdogResult, "ownersScanned" | "ownersSkipped">> {
  const principal = createUserPrincipalFromUser(user, foundation.accountId, foundation.instanceId);

  return runWithPrincipal(principal, async () => {
    const { admissionController } = await import("../run-admission");
    return admissionController.withResourcePool(
      "short_worker",
      `meeting-watchdog:${user.id}:${now.getTime()}`,
      async () => {
        const lookback = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        let events;
        let accountErrors;
        try {
          ({ events, errors: accountErrors } = await listAllEvents({
            timeMin: lookback.toISOString(),
            timeMax: now.toISOString(),
          }));
        } catch (value) {
          const error = normalizeMeetingWatchdogError(
            value,
            "list_events",
            "MEETING_WATCHDOG_LIST_EVENTS_FAILED",
          );
          error.ownerUserId = user.id;
          error.phase = "account_list";
          throw error;
        }

        const errors = accountErrors.map((accountError) => {
          const error = normalizeMeetingWatchdogError(
            accountError.message,
            "list_events",
            "MEETING_WATCHDOG_ACCOUNT_LIST_FAILED",
            `Calendar account list failed for ${accountError.accountId}`,
          );
          error.ownerUserId = user.id;
          error.accountId = accountError.accountId;
          error.phase = "account_list";
          // Account-scoped calendar failures are expected degraded inputs for
          // the owner pass; keep them in the result and warn with attribution.
          log.warn(
            error,
            meetingWatchdogLogContext({
              operation: "list_events",
              ownerUserId: user.id,
              accountId: accountError.accountId,
              phase: "account_list",
            }),
          );
          return `${accountError.accountId}: ${error.message}`;
        });

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
          } catch (value) {
            const error = normalizeMeetingWatchdogError(
              value,
              "process_event",
              "MEETING_WATCHDOG_EVENT_FAILED",
            );
            error.ownerUserId = user.id;
            error.eventId = event.id;
            error.accountId = event.accountId;
            error.phase = "event";
            errors.push(`${event.id}: ${error.message}`);
            // Per-event failures degrade the owner pass without aborting it.
            log.warn(
              error,
              meetingWatchdogLogContext({
                operation: "process_event",
                ownerUserId: user.id,
                eventId: event.id,
                accountId: event.accountId,
                phase: "event",
              }),
            );
          }
        }

        return {
          eventsScanned: endedWithAttendees.length,
          metadataCreated,
          interactionsLogged,
          errors,
        };
      },
      { activity: "timer.meeting_watchdog" },
    );
  });
}

/**
 * Scan recently ended meetings one owner at a time. Identity foundation is the
 * producer filter — suspended/archived/orphan users never enter the set.
 * Connected accounts and every sensitive read/write remain inside the exact
 * owner's principal.
 */
export async function runMeetingWatchdog(): Promise<MeetingWatchdogResult> {
  const result: MeetingWatchdogResult = {
    ownersScanned: 0,
    ownersSkipped: 0,
    eventsScanned: 0,
    metadataCreated: 0,
    interactionsLogged: 0,
    errors: [],
  };

  let owners;
  try {
    // Orphan and non-active accounts never enter this set.
    owners = await listUsersWithIdentityFoundation();
  } catch (value) {
    const error = normalizeMeetingWatchdogError(
      value,
      "process_owner",
      "MEETING_WATCHDOG_OWNER_ENUMERATION_FAILED",
    );
    error.phase = "owner";
    log.error(
      error,
      meetingWatchdogLogContext({
        operation: "process_owner",
        phase: "owner",
      }),
    );
    throw error;
  }

  for (const { user, foundation } of owners) {
    try {
      const ownerResult = await processOwnerMeetings(user, foundation, new Date());
      result.ownersScanned++;
      result.eventsScanned += ownerResult.eventsScanned;
      result.metadataCreated += ownerResult.metadataCreated;
      result.interactionsLogged += ownerResult.interactionsLogged;
      result.errors.push(...ownerResult.errors);
    } catch (value) {
      // Race: account archived/suspended between enumeration and principal work.
      // Skip quietly — same class as the producer filter, not a product defect.
      if (value instanceof AccountLifecycleError) {
        result.ownersSkipped++;
        log.debug("Meeting watchdog skipped owner after account lifecycle change", {
          ownerUserId: user.id,
          code: value.code,
        });
        continue;
      }
      const error = normalizeMeetingWatchdogError(
        value,
        "process_owner",
        "MEETING_WATCHDOG_OWNER_FAILED",
      );
      error.ownerUserId = user.id;
      error.phase = "owner";
      error.errorCount = 1;
      result.errors.push(`${user.id}: ${error.message}`);
      log.error(
        error,
        meetingWatchdogLogContext({
          operation: "process_owner",
          ownerUserId: user.id,
          phase: "owner",
          errorCount: 1,
        }),
      );
    }
  }

  log.info("Meeting watchdog completed", {
    ownersScanned: result.ownersScanned,
    ownersSkipped: result.ownersSkipped,
    eventsScanned: result.eventsScanned,
    metadataCreated: result.metadataCreated,
    interactionsLogged: result.interactionsLogged,
    errorCount: result.errors.length,
  });
  return result;
}
