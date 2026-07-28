import { and, asc, gt, sql } from "drizzle-orm";
import { libraryPages } from "@shared/models/info";
import { db } from "../db";
import { createLogger } from "../log";
import { createNamedSystemPrincipal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { setSetting } from "../system-settings";
import { resolveMeetingTransportSession, runWithMeetingOwnerPrincipal } from "../meeting/owner-principal";
import { sanitizeStoredMeetingRecapPage } from "../meeting/recap";

const log = createLogger("SanitizeMeetingRecapAgendas");
const JOB_NAME = "meeting-recap-agenda-sanitizer";
const STATUS_KEY = "system.meeting_recap_agenda_sanitizer.v1";
const BATCH_SIZE = 100;
const MAX_CANDIDATES = 1_000;

interface Candidate {
  pageId: string;
  sessionId: string | null;
}

export async function runMeetingRecapAgendaSanitizer(): Promise<void> {
  const systemPrincipal = createNamedSystemPrincipal(JOB_NAME, ["system:read"]);
  let cursor = "";
  let scanned = 0;
  let updated = 0;
  let alreadyClean = 0;
  let skipped = 0;
  let failed = 0;

  await runWithPrincipal(systemPrincipal, async () => {
    while (scanned < MAX_CANDIDATES) {
      const candidates: Candidate[] = await db
        .select({
          pageId: libraryPages.id,
          sessionId: libraryPages.createdBySessionId,
        })
        .from(libraryPages)
        .where(and(
          cursor ? gt(libraryPages.id, cursor) : sql`TRUE`,
          sql`${libraryPages.tags} @> ARRAY['meeting', 'recap']::text[]`,
          sql`${libraryPages.plainTextContent} ILIKE ${"%## Agenda%"}`,
        ))
        .orderBy(asc(libraryPages.id))
        .limit(Math.min(BATCH_SIZE, MAX_CANDIDATES - scanned));
      if (candidates.length === 0) break;

      for (const candidate of candidates) {
        cursor = candidate.pageId;
        scanned += 1;
        if (!candidate.sessionId) {
          skipped += 1;
          continue;
        }
        try {
          const session = await resolveMeetingTransportSession(candidate.sessionId);
          const meeting = session?.meeting;
          if (!meeting || meeting.recap?.status !== "ready" || meeting.recap.pageId !== candidate.pageId) {
            skipped += 1;
            continue;
          }
          const outcome = await runWithMeetingOwnerPrincipal(meeting, () =>
            sanitizeStoredMeetingRecapPage(candidate.sessionId!, candidate.pageId),
          );
          if (outcome === "updated") updated += 1;
          else if (outcome === "already_clean") alreadyClean += 1;
          else skipped += 1;
        } catch (error) {
          failed += 1;
          log.error("meeting recap agenda sanitizer candidate failed", {
            pageId: candidate.pageId,
            sessionId: candidate.sessionId,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          });
        }
      }

      if (candidates.length < BATCH_SIZE) break;
    }
  });

  const status = {
    version: 1,
    outcome: failed > 0 ? "completed_with_failures" : "completed",
    scanned,
    updated,
    alreadyClean,
    skipped,
    failed,
    boundedAt: MAX_CANDIDATES,
    recordedAt: new Date().toISOString(),
  };
  await runWithPrincipal(systemPrincipal, () => setSetting(STATUS_KEY, status));
  log.info("meeting recap agenda sanitizer finished", status);
}
