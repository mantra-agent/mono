import { createLogger } from "./log";
import { storage } from "./storage";
import { chatCompletion, type ChatMessage } from "./model-client";
import { ACTIVITY_WORK } from "./job-profiles";
import { triageJob } from "./triage-job-state";
import { archiveEmail } from "./gmail";
import { pool, getDbSaturationInfo } from "./db";
import { DB_POOL_MAX } from "./timeout";
import type { EmailMessage } from "@shared/schema";

const log = createLogger("TriageRunner");

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Defaults intentionally conservative after the Apr 20 production hang
// (Task #809). Pre-fix defaults were 5000/8/(no body cap) which saturated
// the DB pool and blocked the event loop. New defaults stay safe under a
// 1k+ untriaged backlog; raise via env once telemetry shows headroom.
const PER_PASS_HARD_CAP = envInt("TRIAGE_PER_PASS_HARD_CAP", 200, 10, 5000);
const SUB_BATCH_SIZE = envInt("TRIAGE_SUB_BATCH_SIZE", 5, 1, 25);
const WORKER_CONCURRENCY = envInt("TRIAGE_WORKER_CONCURRENCY", 2, 1, 8);
const ARCHIVE_CONCURRENCY = envInt("TRIAGE_ARCHIVE_CONCURRENCY", 4, 1, 16);
const BODY_TRUNCATE_BYTES = envInt("TRIAGE_BODY_TRUNCATE_BYTES", 2048, 256, 32_768);
// Minimum free DB pool slots required before kicking off the next worker
// (or starting a new sub-batch). Keeps headroom for chat / context / health
// queries while triage is running.
const POOL_HEADROOM = envInt("TRIAGE_POOL_HEADROOM", 6, 0, DB_POOL_MAX - 1);
const VALID_TIERS = new Set(["🔴", "🟡", "🟢", "📋", "🗑️"]);
const TIER_NORMALIZE: Record<string, string> = {
  respond_now: "🔴",
  respond_today: "🟡",
  acknowledge: "🟢",
  fyi: "📋",
  noise: "🗑️",
  red: "🔴",
  yellow: "🟡",
  green: "🟢",
};

const SYSTEM_PROMPT = `You are Ray's email triage classifier. Your only job is to assign each email to exactly one tier and write a one-sentence reason. You do not draft replies, look up people, or fetch related context — that work happens in a separate Enrich phase after triage.

Tiers:
- 🔴 Respond Now: requires immediate action or reply (time-sensitive, blocking, from a critical sender).
- 🟡 Respond Today: needs a reply or action today but not urgently.
- 🟢 Acknowledge: worth a quick acknowledgment or brief reply, not urgent.
- 📋 FYI: informational only, no reply needed but worth knowing.
- 🗑️ Noise: not actionable. Promotional, political, cold outbound, automated alerts, etc.

Auto-dismiss to 🗑️ Noise:
- Political campaign / PAC / fundraising / petition emails (regardless of sender).
- Promotional / marketing / newsletter / retail / mass-market emails (List-Unsubscribe header, marketing-platform sender domains, "Save 20%", etc.).
- Cold outbound from senders with no prior relationship (sales pitches, vendor outreach, recruiter spam, templated "quick question" intros).

Never tier as 📋 FYI or 🗑️ Noise:
- A reply on a thread Ray started or has replied on (a real correspondent responding to Ray is always at least 🟢).
- A message that confirms, proposes, or changes a meeting time. Confirmation is not completion — the meeting still has to be put on the calendar, so it needs action: tier 🟡 or higher.

When uncertain between two tiers, tier UP (more important).

You will be given a JSON array of emails. Bodies may be truncated to a leading prefix — that is intentional; classify from headers + the prefix. Respond with a single JSON object of the form:
{ "results": [ { "id": <cacheId>, "tier": "<emoji>", "reason": "<one sentence>" }, ... ] }

Every input email must appear in the output exactly once, keyed by its cacheId. Tier must be one of: 🔴, 🟡, 🟢, 📋, 🗑️.`;

interface ClassifyResult {
  id: number;
  tier: string;
  reason: string;
}

function truncateBody(body: string, limit: number): { text: string; truncated: boolean } {
  if (!body) return { text: "", truncated: false };
  if (body.length <= limit) return { text: body, truncated: false };
  return { text: body.slice(0, limit), truncated: true };
}

export function buildEmailPayload(emails: EmailMessage[], bodyLimit: number = BODY_TRUNCATE_BYTES): string {
  // Bulk-pass payload: headers + truncated body prefix. Full-body re-classification
  // can be added later as a low-confidence fallback, but for the bulk pass the
  // prefix carries the marketing/political/cold-outbound signals we care about.
  const items = emails.map((e) => {
    const { text, truncated } = truncateBody(e.bodyText || "", bodyLimit);
    return {
      id: e.id,
      accountId: e.accountId,
      from: e.fromAddress || "unknown",
      to: e.toAddresses || "",
      cc: e.ccAddresses || "",
      subject: e.subject || "(no subject)",
      date: e.date ? new Date(e.date).toISOString() : "unknown",
      snippet: e.snippet || "",
      labels: e.labelIds || [],
      bodyTruncated: truncated,
      bodyBytes: (e.bodyText || "").length,
      body: text,
    };
  });
  return JSON.stringify({ emails: items });
}

async function classifySubBatch(emails: EmailMessage[]): Promise<ClassifyResult[]> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildEmailPayload(emails) },
  ];

  const result = await chatCompletion({
    activity: ACTIVITY_WORK,
    messages,
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 4000,
    metadata: { source: "triage-runner", activity: ACTIVITY_WORK },
  });

  let parsed: any;
  try {
    let raw = result.content;
    // Strip markdown code fences if present (LLM sometimes wraps JSON)
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) raw = fenceMatch[1];
    parsed = JSON.parse(raw);
  } catch (err: any) {
    log.warn(`classifySubBatch JSON parse failed: ${err.message} — raw: ${result.content.slice(0, 300)}`);
    throw new Error(`Classifier returned non-JSON output: ${err.message}`);
  }

  const rawResults: any[] = Array.isArray(parsed?.results) ? parsed.results : [];
  const byId = new Map<number, ClassifyResult>();
  for (const r of rawResults) {
    const id = Number(r?.id);
    if (!Number.isFinite(id)) continue;
    let tier = String(r?.tier || "").trim();
    tier = TIER_NORMALIZE[tier.toLowerCase()] || tier;
    if (!VALID_TIERS.has(tier)) continue;
    const reason = String(r?.reason || "").trim().slice(0, 280) || "(no reason)";
    byId.set(id, { id, tier, reason });
  }

  const final: ClassifyResult[] = [];
  for (const e of emails) {
    const got = byId.get(e.id);
    if (got) {
      final.push(got);
    } else {
      log.warn(`classifySubBatch model omitted cacheId=${e.id} — defaulting to 📋 FYI`);
      final.push({ id: e.id, tier: "📋", reason: "Auto-defaulted (classifier omitted result)" });
    }
  }
  return final;
}

async function runArchives(dismissed: Array<{ accountId: string; providerMessageId: string }>): Promise<void> {
  if (dismissed.length === 0) return;
  let cursor = 0;
  let succeeded = 0;
  let failed = 0;
  async function worker() {
    while (cursor < dismissed.length) {
      const idx = cursor++;
      const d = dismissed[idx];
      try {
        await archiveEmail(d.accountId, d.providerMessageId);
        succeeded++;
      } catch (err: any) {
        failed++;
        log.debug(`archive failed acct=${d.accountId} msg=${d.providerMessageId}: ${err?.message}`);
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(ARCHIVE_CONCURRENCY, dismissed.length) },
    () => worker(),
  );
  await Promise.all(workers);
  log.log(`archives complete: succeeded=${succeeded} failed=${failed} of ${dismissed.length}`);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForPoolHeadroom(maxWaitMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const free = (DB_POOL_MAX - pool.totalCount) + pool.idleCount;
    const waiting = pool.waitingCount;
    if (free >= POOL_HEADROOM && waiting === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Logged once per call so we surface backpressure without spamming.
  const sat = getDbSaturationInfo();
  log.warn(`waitForPoolHeadroom: timed out (${maxWaitMs}ms) waiting for ${POOL_HEADROOM} free slots — pool=${sat.total}/${sat.idle}/${sat.waiting}, proceeding anyway`);
}

export interface TriagePipelineResult {
  status: "succeeded" | "failed";
  processed: number;
  triaged: number;
  dismissed: number;
  passes: number;
  totalMs: number;
  avgPerEmailMs: number;
  error?: string;
}

export async function runTriagePipeline(): Promise<TriagePipelineResult> {
  const startedAt = Date.now();
  let totalProcessed = 0;
  let totalTriaged = 0;
  let totalDismissed = 0;
  let passes = 0;

  triageJob.status = "running";
  triageJob.processed = 0;
  triageJob.total = 0;
  triageJob.triaged = 0;
  triageJob.startedAt = startedAt;
  triageJob.completedAt = null;
  triageJob.error = null;
  triageJob.workersInFlight = 0;
  triageJob.avgPerEmailMs = 0;
  triageJob.remaining = 0;
  triageJob.passes = 0;

  log.log(`runTriagePipeline started — workers=${WORKER_CONCURRENCY} subBatch=${SUB_BATCH_SIZE} hardCap=${PER_PASS_HARD_CAP} bodyBytes=${BODY_TRUNCATE_BYTES} poolHeadroom=${POOL_HEADROOM}`);

  try {
    while (true) {
      const batch = await storage.getUntriagedCachedEmails(PER_PASS_HARD_CAP);
      if (batch.length === 0) {
        log.log(`runTriagePipeline pass=${passes + 1} — no untriaged emails remaining, done`);
        break;
      }
      passes++;
      triageJob.passes = passes;
      triageJob.total += batch.length;
      triageJob.remaining = batch.length;

      log.debug(`runTriagePipeline pass=${passes} — pulled ${batch.length} untriaged emails (total ever=${triageJob.total})`);

      const subBatches: EmailMessage[][] = [];
      for (let i = 0; i < batch.length; i += SUB_BATCH_SIZE) {
        subBatches.push(batch.slice(i, i + SUB_BATCH_SIZE));
      }

      const allResults: ClassifyResult[] = [];
      const dismissedQueue: Array<{ accountId: string; providerMessageId: string }> = [];
      let passPersisted = 0;

      let bIdx = 0;
      async function worker() {
        triageJob.workersInFlight++;
        try {
          while (true) {
            // Reserve a sub-batch index BEFORE any awaits so two workers
            // can't both read a stale `bIdx` and process the same batch
            // (or sail past the end and dereference `subBatches[undefined]`).
            const i = bIdx++;
            if (i >= subBatches.length) break;
            const sub = subBatches[i];

            // Yield + backpressure check between sub-batches so the event
            // loop can run health probes / heartbeats and we don't hold
            // every connection while chat/context queries are queued.
            await yieldToEventLoop();
            await waitForPoolHeadroom();
            const subStart = Date.now();
            try {
              const results = await classifySubBatch(sub);
              allResults.push(...results);

              const updates = results.map((r) => ({ id: r.id, tier: r.tier, reason: r.reason }));
              const dismissed = await storage.batchUpdateEmailTriageState(updates);
              dismissedQueue.push(...dismissed);
              passPersisted += updates.length;
              try {
                const { processEmailPeopleSignals, fromCachedEmail } = await import("./email-people-signals");
                const tierByMessageId = new Map<number, { tier: string; reason?: string }>();
                const signalRows = sub.map((email) => {
                  const result = results.find((r) => r.id === email.id);
                  if (result) tierByMessageId.set(email.id, { tier: result.tier, reason: result.reason });
                  return fromCachedEmail(email as any);
                });
                await processEmailPeopleSignals(signalRows, { source: "email_triage", tierByMessageId });
              } catch (peopleErr: any) {
                log.debug(`pass=${passes} sub=${i + 1} people signal processing failed: ${peopleErr.message}`);
              }

              triageJob.processed += sub.length;
              triageJob.triaged += results.length;
              triageJob.remaining = Math.max(0, batch.length - (i + 1) * SUB_BATCH_SIZE + (sub.length - SUB_BATCH_SIZE));
              const elapsed = Date.now() - startedAt;
              triageJob.avgPerEmailMs = triageJob.processed > 0 ? Math.round(elapsed / triageJob.processed) : 0;

              const subMs = Date.now() - subStart;
              log.debug(`pass=${passes} sub=${i + 1}/${subBatches.length} (${sub.length} emails) classified in ${subMs}ms`);
            } catch (err: any) {
              log.warn(`pass=${passes} sub=${i + 1}/${subBatches.length} classification failed: ${err.message} — defaulting batch to 🟢`);
              triageJob.lastTriageError = { message: err.message, timestamp: Date.now() };
              const fallback = sub.map((e) => ({ id: e.id, tier: "🟢", reason: "Auto-defaulted (classifier error)" }));
              try {
                await storage.batchUpdateEmailTriageState(fallback);
                passPersisted += fallback.length;
              } catch (persistErr: any) {
                log.error(`pass=${passes} sub=${i + 1} fallback persist also failed: ${persistErr.message}`);
              }
              triageJob.processed += sub.length;
              triageJob.triaged += sub.length;
            }
          }
        } finally {
          triageJob.workersInFlight--;
        }
      }

      const workerCount = Math.min(WORKER_CONCURRENCY, subBatches.length);
      const workers = Array.from({ length: workerCount }, () =>
        worker().catch((e) => {
          // Surface unhandled rejections from the fan-out so they don't
          // silently leave triageJob.workersInFlight imbalanced.
          log.error(`triage worker crashed: ${e?.message || e}`);
        }),
      );
      await Promise.all(workers);

      await runArchives(dismissedQueue);

      totalProcessed += batch.length;
      totalTriaged += allResults.length;
      totalDismissed += dismissedQueue.length;
      log.debug(`runTriagePipeline pass=${passes} done — processed=${batch.length} triaged=${allResults.length} persisted=${passPersisted} dismissed=${dismissedQueue.length}`);

      if (passPersisted === 0) {
        throw new Error(
          `Triage pass ${passes} produced zero persisted updates across ${batch.length} emails — aborting to prevent infinite loop`,
        );
      }

      if (batch.length < PER_PASS_HARD_CAP) {
        const recheck = await storage.getUntriagedCachedEmails(1);
        if (recheck.length === 0) break;
      }
    }

    const totalMs = Date.now() - startedAt;
    const avg = totalProcessed > 0 ? Math.round(totalMs / totalProcessed) : 0;
    triageJob.status = "completed";
    triageJob.completedAt = Date.now();
    triageJob.avgPerEmailMs = avg;
    triageJob.remaining = 0;
    triageJob.lastTriageError = null;
    log.log(`runTriagePipeline succeeded: passes=${passes} processed=${totalProcessed} triaged=${totalTriaged} dismissed=${totalDismissed} totalMs=${totalMs} avgPerEmail=${avg}ms`);

    return {
      status: "succeeded",
      processed: totalProcessed,
      triaged: totalTriaged,
      dismissed: totalDismissed,
      passes,
      totalMs,
      avgPerEmailMs: avg,
    };
  } catch (err: any) {
    const totalMs = Date.now() - startedAt;
    log.error(`runTriagePipeline failed after ${totalMs}ms: ${err.message}`);
    triageJob.status = "error";
    triageJob.completedAt = Date.now();
    triageJob.error = err.message;
    return {
      status: "failed",
      processed: totalProcessed,
      triaged: totalTriaged,
      dismissed: totalDismissed,
      passes,
      totalMs,
      avgPerEmailMs: totalProcessed > 0 ? Math.round(totalMs / totalProcessed) : 0,
      error: err.message,
    };
  }
}

export const __testing = {
  PER_PASS_HARD_CAP,
  SUB_BATCH_SIZE,
  WORKER_CONCURRENCY,
  BODY_TRUNCATE_BYTES,
  POOL_HEADROOM,
  truncateBody,
};
