import { randomUUID } from "crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Response } from "express";
import {
  MEETING_AUDIO_CONSENT_VERSION,
  MEETING_AUDIO_MAX_BYTES,
  MEETING_AUDIO_MAX_DURATION_MS,
  MEETING_AUDIO_MAX_RETENTION_DAYS,
  meetingAudioEvaluations,
  meetingAudioSamples,
  type MeetingAudioRecognitionProvenance,
  type MeetingAudioRetentionState,
  type MeetingAudioSample,
} from "@shared/models/meeting-audio";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db } from "../db";
import { decryptBuffer, encryptBuffer, getEncryptionKey, getPreviousEncryptionKey, isEncryptedEnvelope } from "../encryption";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import { ObjectStorageService, deleteObjectAclPolicy, storageBackend } from "../object_storage";
import { getVisibleEnvironment } from "../platforms/platform-access";
import { createNamedSystemPrincipal, type Principal } from "../principal";
import { requireCurrentPrincipal, requireCurrentUserPrincipal, runWithPrincipal } from "../principal-context";
import {
  createSerializedRecognitionSink,
  getSpeechRecognitionAdapter,
  mintRecognitionAttemptId,
  resolveSpeechRecognitionBindingCredential,
  type STTUtterance,
} from "../speech-recognition";
import { principalOwnsMeeting, runWithMeetingOwnerIdentity } from "./owner-principal";

const log = createLogger("MeetingAudioRetention");
const SOURCE_KEY = "native:microphone";
const REPLAY_CHUNK_BYTES = 3_200;
const REPLAY_CHUNK_MS = 100;
const REPLAY_WRITE_DEADLINE_MS = 5_000;
const MAX_EVALUATION_UTTERANCES = 10_000;
const EXPIRY_BATCH_SIZE = 25;

function requireUserPrincipal(principal: Principal = requireCurrentUserPrincipal()): Principal & { userId: string; accountId: string } {
  if (!principal.activeVaultId) {
    throw Object.assign(new Error("A user principal with an active Vault is required"), { status: 401 });
  }
  return principal as Principal & { userId: string; accountId: string };
}

function sampleVisibleToPrincipal(sample: MeetingAudioSample, principal: Principal): boolean {
  return principal.actorType === "user"
    && sample.ownerUserId === principal.userId
    && sample.accountId === principal.accountId
    && principal.visibleVaultIds.includes(sample.vaultId);
}

function scopeSample(sampleId: string, principal: Principal & { userId: string; accountId: string }) {
  return and(
    eq(meetingAudioSamples.id, sampleId),
    eq(meetingAudioSamples.scope, "user"),
    eq(meetingAudioSamples.ownerUserId, principal.userId),
    eq(meetingAudioSamples.accountId, principal.accountId),
    inArray(meetingAudioSamples.vaultId, principal.visibleVaultIds.length > 0 ? principal.visibleVaultIds : ["__none__"]),
  );
}

async function acquireSampleLifecycleLock(
  tx: Parameters<typeof acquireAdvisoryTransactionLock>[0],
  sampleId: string,
): Promise<void> {
  await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.MEETING_AUDIO_SAMPLE, sampleId);
}

function retentionState(sample: MeetingAudioSample): MeetingAudioRetentionState {
  return {
    sampleId: sample.id,
    status: sample.status,
    consentVersion: MEETING_AUDIO_CONSENT_VERSION,
    consentedAt: sample.consentedAt.toISOString(),
    expiresAt: sample.expiresAt.toISOString(),
    ...(sample.byteCount > 0 ? { byteCount: sample.byteCount } : {}),
    ...(sample.durationMs > 0 ? { durationMs: sample.durationMs } : {}),
    ...(sample.failureCode ? { failureCode: sample.failureCode } : {}),
  };
}

function safeFailureCode(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "evaluation_failed";
}

function provenanceFromMeeting(session: Awaited<ReturnType<typeof chatStorage.getSession>>): MeetingAudioRecognitionProvenance[] {
  if (!session) return [];
  const seen = new Set<string>();
  const result: MeetingAudioRecognitionProvenance[] = [];
  for (const message of session.messages || []) {
    const recognition = message.recognition;
    if (!recognition || seen.has(recognition.attemptId)) continue;
    seen.add(recognition.attemptId);
    result.push({
      attemptId: recognition.attemptId,
      bindingId: recognition.bindingId,
      adapterKind: recognition.adapterKind,
      provider: recognition.provider,
      model: recognition.model,
      configFingerprint: recognition.configFingerprint,
    });
  }
  return result.slice(0, 100);
}

async function decryptStoredBuffer(objectKey: string): Promise<Buffer> {
  const encryptedBytes = await storageBackend.getObjectBuffer(objectKey);
  if (encryptedBytes.length > 48 * 1024 * 1024) throw new Error("Encrypted meeting audio exceeded its storage budget");
  let envelope: unknown;
  try {
    envelope = JSON.parse(encryptedBytes.toString("utf8"));
  } catch {
    throw new Error("Retained meeting audio envelope is invalid");
  }
  if (!isEncryptedEnvelope(envelope)) throw new Error("Retained meeting audio envelope is invalid");
  try {
    return await decryptBuffer(envelope, getEncryptionKey());
  } catch {
    const previous = getPreviousEncryptionKey();
    if (!previous) throw new Error("Retained meeting audio cannot be decrypted");
    return decryptBuffer(envelope, previous);
  }
}

function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function createConsentedMeetingAudioSample(input: {
  sessionId: string;
  consentVersion: number;
  retentionDays: number;
}): Promise<MeetingAudioRetentionState> {
  const principal = requireUserPrincipal();
  if (input.consentVersion !== MEETING_AUDIO_CONSENT_VERSION) throw new Error("Unsupported meeting-audio consent version");
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > MEETING_AUDIO_MAX_RETENTION_DAYS) {
    throw new Error(`Meeting audio retention must be between 1 and ${MEETING_AUDIO_MAX_RETENTION_DAYS} days`);
  }
  const session = await chatStorage.getSession(input.sessionId);
  if (!session?.meeting || !principalOwnsMeeting(principal, session) || session.meeting.transport !== "native") {
    throw Object.assign(new Error("Meeting not found"), { status: 404 });
  }
  const [existing] = await db.select().from(meetingAudioSamples).where(and(
    eq(meetingAudioSamples.sessionId, input.sessionId),
    eq(meetingAudioSamples.sourceKey, SOURCE_KEY),
    eq(meetingAudioSamples.ownerUserId, principal.userId),
    eq(meetingAudioSamples.accountId, principal.accountId),
    eq(meetingAudioSamples.vaultId, session.meeting.vaultId || principal.activeVaultId),
  )).limit(1);
  if (existing) {
    if (!["recording", "ready"].includes(existing.status)) throw new Error("This meeting audio sample is no longer recordable");
    const state = retentionState(existing);
    await chatStorage.updateMeetingMeta(input.sessionId, { audioRetention: state });
    return state;
  }
  const consentedAt = new Date();
  const expiresAt = new Date(consentedAt.getTime() + input.retentionDays * 86_400_000);
  const [sample] = await db.insert(meetingAudioSamples).values({
    sessionId: input.sessionId,
    sourceKey: SOURCE_KEY,
    status: "recording",
    consentVersion: MEETING_AUDIO_CONSENT_VERSION,
    consentedAt,
    retentionDays: input.retentionDays,
    expiresAt,
    scope: "user",
    ownerUserId: principal.userId,
    accountId: principal.accountId,
    vaultId: session.meeting.vaultId || principal.activeVaultId,
    createdByUserId: principal.userId,
  }).onConflictDoNothing().returning();
  if (!sample) {
    const [concurrent] = await db.select().from(meetingAudioSamples).where(and(
      eq(meetingAudioSamples.sessionId, input.sessionId),
      eq(meetingAudioSamples.sourceKey, SOURCE_KEY),
      eq(meetingAudioSamples.ownerUserId, principal.userId),
      eq(meetingAudioSamples.accountId, principal.accountId),
    )).limit(1);
    if (!concurrent || !["recording", "ready"].includes(concurrent.status)) throw new Error("This meeting audio sample is no longer recordable");
    const state = retentionState(concurrent);
    await chatStorage.updateMeetingMeta(input.sessionId, { audioRetention: state });
    return state;
  }
  if (!["recording", "ready"].includes(sample.status)) throw new Error("This meeting audio sample is no longer recordable");
  await chatStorage.updateMeetingMeta(input.sessionId, { audioRetention: retentionState(sample) });
  log.info("Meeting audio retention consent recorded", {
    sampleId: sample.id,
    sessionId: sample.sessionId,
    retentionDays: sample.retentionDays,
  });
  return retentionState(sample);
}

export interface MeetingAudioRecorder {
  append(bytes: Buffer): boolean;
  finalize(): Promise<void>;
  fail(code: string): Promise<void>;
}

export async function openConsentedMeetingAudioRecorder(
  sessionId: string,
  principalInput: Principal,
): Promise<MeetingAudioRecorder | null> {
  const principal = requireUserPrincipal(principalInput);
  const [sample] = await db.select().from(meetingAudioSamples).where(and(
    eq(meetingAudioSamples.sessionId, sessionId),
    eq(meetingAudioSamples.sourceKey, SOURCE_KEY),
    eq(meetingAudioSamples.status, "recording"),
    eq(meetingAudioSamples.ownerUserId, principal.userId),
    eq(meetingAudioSamples.accountId, principal.accountId),
    inArray(meetingAudioSamples.vaultId, principal.visibleVaultIds),
  )).limit(1);
  if (!sample) return null;

  const chunks: Buffer[] = [];
  let byteCount = 0;
  let terminal = false;
  let terminalPromise: Promise<void> | null = null;

  const updateMeetingProjection = async (next: MeetingAudioSample): Promise<void> => {
    await chatStorage.updateMeetingMeta(sessionId, { audioRetention: retentionState(next) });
  };

  const fail = async (code: string): Promise<void> => {
    if (terminalPromise) return terminalPromise;
    terminal = true;
    terminalPromise = (async () => {
      chunks.length = 0;
      const [updated] = await db.update(meetingAudioSamples).set({
        status: "failed",
        failureCode: code.slice(0, 80),
        byteCount,
        durationMs: Math.min(MEETING_AUDIO_MAX_DURATION_MS, Math.round(byteCount / 32)),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(scopeSample(sample.id, principal)).returning();
      if (updated) await updateMeetingProjection(updated);
      log.warn("Meeting audio retention failed", { sampleId: sample.id, sessionId, failureCode: code.slice(0, 80), byteCount });
    })();
    return terminalPromise;
  };

  return {
    append(bytes) {
      if (terminal || bytes.length === 0) return !terminal;
      const nextByteCount = byteCount + bytes.length;
      const nextDurationMs = Math.round(nextByteCount / 32);
      if (nextByteCount > MEETING_AUDIO_MAX_BYTES || nextDurationMs > MEETING_AUDIO_MAX_DURATION_MS) {
        void fail("capture_budget_exceeded");
        return false;
      }
      chunks.push(Buffer.from(bytes));
      byteCount = nextByteCount;
      return true;
    },
    async finalize() {
      if (terminalPromise) return terminalPromise;
      terminal = true;
      terminalPromise = (async () => {
        if (byteCount === 0) {
          const [updated] = await db.update(meetingAudioSamples).set({
            status: "failed",
            failureCode: "empty_capture",
            updatedAt: sql`CURRENT_TIMESTAMP`,
          }).where(and(scopeSample(sample.id, principal), eq(meetingAudioSamples.status, "recording"))).returning();
          if (updated) await updateMeetingProjection(updated);
          return;
        }
        const currentSession = await chatStorage.getSession(sessionId);
        const provenance = provenanceFromMeeting(currentSession);
        const plaintext = Buffer.concat(chunks, byteCount);
        chunks.length = 0;
        const envelope = await encryptBuffer(plaintext, getEncryptionKey());
        plaintext.fill(0);
        const storage = new ObjectStorageService();
        const upload = await storage.uploadObjectEntity(Buffer.from(JSON.stringify(envelope), "utf8"), {
          extension: "json",
          contentType: "application/vnd.mantra.encrypted-audio+json",
          category: "meeting-audio",
          principal,
          acl: {
            owner: principal.userId,
            ownerUserId: principal.userId,
            accountId: principal.accountId,
            createdByUserId: principal.userId,
            scope: "user",
            visibility: "private",
          },
        });
        const [updated] = await db.update(meetingAudioSamples).set({
          status: "ready",
          objectKey: upload.objectKey,
          byteCount,
          durationMs: Math.round(byteCount / 32),
          originalRecognitionProvenance: provenance,
          failureCode: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(scopeSample(sample.id, principal), eq(meetingAudioSamples.status, "recording"))).returning();
        if (!updated) {
          await storageBackend.deleteObject(upload.objectKey);
          await deleteObjectAclPolicy(upload.objectKey);
          return;
        }
        await updateMeetingProjection(updated);
        log.info("Meeting audio retained", {
          sampleId: sample.id,
          sessionId,
          byteCount,
          durationMs: updated.durationMs,
          provenanceAttemptCount: provenance.length,
        });
      })().catch(async (error) => {
        log.error("Meeting audio finalization failed", {
          sampleId: sample.id,
          sessionId,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        const [updated] = await db.update(meetingAudioSamples).set({
          status: "failed",
          failureCode: "storage_failed",
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(scopeSample(sample.id, principal), eq(meetingAudioSamples.status, "recording"))).returning();
        if (updated) await updateMeetingProjection(updated);
      });
      return terminalPromise;
    },
    fail,
  };
}

export async function exportMeetingAudioSample(sampleId: string, res: Response): Promise<void> {
  const principal = requireUserPrincipal();
  const [sample] = await db.select().from(meetingAudioSamples).where(scopeSample(sampleId, principal)).limit(1);
  if (!sample || sample.status !== "ready" || !sample.objectKey) throw Object.assign(new Error("Retained audio is not available"), { status: 404 });
  const pcm = await decryptStoredBuffer(sample.objectKey);
  if (pcm.length !== sample.byteCount || pcm.length > MEETING_AUDIO_MAX_BYTES) throw new Error("Retained audio integrity check failed");
  const wav = pcmToWav(pcm);
  pcm.fill(0);
  res.set({
    "Content-Type": "audio/wav",
    "Content-Length": String(wav.length),
    "Content-Disposition": `attachment; filename="meeting-audio-${sample.id}.wav"`,
    "Cache-Control": "private, no-store",
  });
  res.send(wav);
  log.info("Meeting audio exported", { sampleId: sample.id, sessionId: sample.sessionId, byteCount: sample.byteCount });
}

export async function deleteMeetingAudioSample(sampleId: string, reason: "owner" | "meeting" | "expired"): Promise<boolean> {
  const principal = requireUserPrincipal();
  const deletedStatus = reason === "expired" ? "expired" : "deleted";
  const claimed = await db.transaction(async (tx) => {
    await acquireSampleLifecycleLock(tx, sampleId);
    const [sample] = await tx.select().from(meetingAudioSamples).where(scopeSample(sampleId, principal)).limit(1);
    if (!sample) return null;
    const running = await tx.select({ id: meetingAudioEvaluations.id }).from(meetingAudioEvaluations).where(and(
      eq(meetingAudioEvaluations.sampleId, sample.id),
      eq(meetingAudioEvaluations.status, "running"),
      eq(meetingAudioEvaluations.ownerUserId, principal.userId),
      eq(meetingAudioEvaluations.accountId, principal.accountId),
      eq(meetingAudioEvaluations.vaultId, sample.vaultId),
    )).limit(1);
    if (running.length > 0) throw Object.assign(new Error("Audio cannot be deleted while an evaluation is running"), { status: 409 });
    const evaluations = await tx.select().from(meetingAudioEvaluations).where(and(
      eq(meetingAudioEvaluations.sampleId, sample.id),
      eq(meetingAudioEvaluations.ownerUserId, principal.userId),
      eq(meetingAudioEvaluations.accountId, principal.accountId),
      eq(meetingAudioEvaluations.vaultId, sample.vaultId),
    ));
    const deletedAt = new Date();
    await tx.update(meetingAudioEvaluations).set({
      status: "deleted",
      deletedAt,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).where(and(
      eq(meetingAudioEvaluations.sampleId, sample.id),
      eq(meetingAudioEvaluations.ownerUserId, principal.userId),
      eq(meetingAudioEvaluations.accountId, principal.accountId),
      eq(meetingAudioEvaluations.vaultId, sample.vaultId),
    ));
    await tx.update(meetingAudioSamples).set({
      status: deletedStatus,
      deletedAt,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).where(scopeSample(sample.id, principal));
    return { sample, evaluations };
  });
  if (!claimed) return false;
  const { sample, evaluations } = claimed;
  for (const evaluation of evaluations) {
    if (!evaluation.resultObjectKey) continue;
    try {
      await storageBackend.deleteObject(evaluation.resultObjectKey);
      await deleteObjectAclPolicy(evaluation.resultObjectKey);
      await db.update(meetingAudioEvaluations).set({
        resultObjectKey: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(and(
        eq(meetingAudioEvaluations.id, evaluation.id),
        eq(meetingAudioEvaluations.status, "deleted"),
        eq(meetingAudioEvaluations.ownerUserId, principal.userId),
        eq(meetingAudioEvaluations.accountId, principal.accountId),
        eq(meetingAudioEvaluations.vaultId, sample.vaultId),
      ));
    } catch (error) {
      log.error("Meeting audio evaluation object deletion failed", {
        evaluationId: evaluation.id,
        sampleId: sample.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw new Error("Retained audio evaluation could not be deleted");
    }
  }
  if (sample.objectKey) {
    try {
      await storageBackend.deleteObject(sample.objectKey);
      await deleteObjectAclPolicy(sample.objectKey);
      await db.update(meetingAudioSamples).set({
        objectKey: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(and(scopeSample(sample.id, principal), eq(meetingAudioSamples.status, deletedStatus)));
    } catch (error) {
      log.error("Meeting audio object deletion failed", {
        sampleId: sample.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw new Error("Retained audio could not be deleted");
    }
  }
  const session = await chatStorage.getSession(sample.sessionId);
  if (session?.meeting && principalOwnsMeeting(principal, session)) {
    await chatStorage.updateMeetingMeta(sample.sessionId, {
      audioRetention: { ...retentionState(sample), status: deletedStatus },
    });
  }
  log.info("Meeting audio deleted", { sampleId: sample.id, sessionId: sample.sessionId, reason });
  return true;
}

export async function deleteMeetingAudioForSession(sessionId: string): Promise<void> {
  const principal = requireUserPrincipal();
  const samples = await db.select().from(meetingAudioSamples).where(and(
    eq(meetingAudioSamples.sessionId, sessionId),
    eq(meetingAudioSamples.ownerUserId, principal.userId),
    eq(meetingAudioSamples.accountId, principal.accountId),
    inArray(meetingAudioSamples.vaultId, principal.visibleVaultIds),
  ));
  for (const sample of samples) await deleteMeetingAudioSample(sample.id, "meeting");
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function runEvaluation(evaluationId: string, sample: MeetingAudioSample, environmentId: number, bindingId: number, principal: Principal): Promise<void> {
  await runWithPrincipal(principal, async () => {
    const startedAt = Date.now();
    const binding = await resolveSpeechRecognitionBindingCredential({ environmentId, bindingId });
    if (!binding.config.useCases.includes("meeting_shared_room")) throw new Error("Selected binding does not support shared-room meeting audio");
    const pcm = await decryptStoredBuffer(sample.objectKey!);
    if (pcm.length !== sample.byteCount || pcm.length > MEETING_AUDIO_MAX_BYTES) throw new Error("Retained audio integrity check failed");
    const attemptId = mintRecognitionAttemptId();
    const utterances: STTUtterance[] = [];
    let firstFinalLatencyMs: number | null = null;
    let providerFailure: Error | null = null;
    const sink = createSerializedRecognitionSink((utterance) => {
      if (!utterance.isFinal || utterances.length >= MAX_EVALUATION_UTTERANCES) return;
      if (firstFinalLatencyMs === null) firstFinalLatencyMs = Date.now() - startedAt;
      utterances.push(utterance);
    }, (error) => { providerFailure = error; });
    const adapter = getSpeechRecognitionAdapter(binding.adapterKind);
    let providerSession: Awaited<ReturnType<typeof adapter.connect>> | null = null;
    try {
      providerSession = await adapter.connect(binding, {
      streamId: `evaluation:${evaluationId}`,
      participant: { transportId: "retained-sample", label: "Retained sample" },
      encoding: "pcm_s16le",
      sampleRateHz: 16_000,
      channels: 1,
    }, sink, attemptId);
    for (let offset = 0; offset < pcm.length; offset += REPLAY_CHUNK_BYTES) {
      const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + REPLAY_CHUNK_BYTES));
      const deadline = Date.now() + REPLAY_WRITE_DEADLINE_MS;
      let outcome = providerSession.tryWriteAudio(chunk);
      while (outcome === "blocked" && Date.now() < deadline) {
        await wait(20);
        outcome = providerSession.tryWriteAudio(chunk);
      }
      if (outcome !== "accepted") throw new Error("Selected speech binding could not accept replay audio within budget");
      await wait(REPLAY_CHUNK_MS);
    }
    pcm.fill(0);
    const finishStartedAt = Date.now();
    const finish = await providerSession.finish();
    await sink.settle();
    if (finish.outcome !== "finished" || providerFailure) throw new Error("Selected speech binding did not finish cleanly");
    const finalizationLatencyMs = Date.now() - finishStartedAt;
    const result = {
      version: 1,
      sampleId: sample.id,
      evaluationId,
      originalRecognitionProvenance: sample.originalRecognitionProvenance,
      replayRecognitionProvenance: {
        attemptId,
        bindingId,
        environmentId,
        adapterKind: binding.adapterKind,
        provider: binding.provider,
        model: binding.model,
        configFingerprint: binding.configFingerprint,
      },
      utterances: utterances.map((utterance) => ({
        utteranceId: utterance.utteranceId,
        text: utterance.text,
        providerSpeakerId: utterance.providerSpeakerId,
        startedAt: utterance.startedAt,
        endedAt: utterance.endedAt,
        confidence: utterance.confidence,
      })),
    };
    const envelope = await encryptBuffer(Buffer.from(JSON.stringify(result), "utf8"), getEncryptionKey());
    const storage = new ObjectStorageService();
    const upload = await storage.uploadObjectEntity(Buffer.from(JSON.stringify(envelope), "utf8"), {
      extension: "json",
      contentType: "application/vnd.mantra.encrypted-recognition-evaluation+json",
      category: "meeting-audio-evaluations",
      principal,
      acl: {
        owner: sample.ownerUserId,
        ownerUserId: sample.ownerUserId,
        accountId: sample.accountId,
        createdByUserId: sample.ownerUserId,
        scope: "user",
        visibility: "private",
      },
    });
    await db.update(meetingAudioEvaluations).set({
      status: "completed",
      attemptId,
      adapterKind: binding.adapterKind,
      provider: binding.provider,
      model: binding.model,
      configFingerprint: binding.configFingerprint,
      resultObjectKey: upload.objectKey,
      utteranceCount: utterances.length,
      firstFinalLatencyMs,
      finalizationLatencyMs,
      completedAt: new Date(),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).where(and(
      eq(meetingAudioEvaluations.id, evaluationId),
      eq(meetingAudioEvaluations.ownerUserId, sample.ownerUserId),
      eq(meetingAudioEvaluations.accountId, sample.accountId),
      eq(meetingAudioEvaluations.status, "running"),
    ));
      log.info("Meeting audio evaluation completed", {
        evaluationId,
        sampleId: sample.id,
        environmentId,
        bindingId,
        utteranceCount: utterances.length,
        firstFinalLatencyMs,
        finalizationLatencyMs,
      });
    } finally {
      pcm.fill(0);
      providerSession?.abort("Replay evaluation cleanup");
    }
  });
}

export async function queueMeetingAudioEvaluation(input: {
  sampleId: string;
  environmentId: number;
  bindingId: number;
  idempotencyKey: string;
}): Promise<{ evaluationId: string; status: string }> {
  const principal = requireUserPrincipal();
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 120) throw new Error("A bounded idempotency key is required");
  const environment = await getVisibleEnvironment(input.environmentId);
  if (!environment || environment.environment.name.trim().toLowerCase() !== "stage") {
    throw new Error("Retained audio evaluation is restricted to an explicit Stage environment");
  }
  await resolveSpeechRecognitionBindingCredential({ environmentId: input.environmentId, bindingId: input.bindingId });
  const prepared = await db.transaction(async (tx) => {
    await acquireSampleLifecycleLock(tx, input.sampleId);
    const [sample] = await tx.select().from(meetingAudioSamples).where(scopeSample(input.sampleId, principal)).limit(1);
    if (!sample || sample.status !== "ready" || !sample.objectKey || sample.expiresAt <= new Date()) {
      throw Object.assign(new Error("Retained audio is not available"), { status: 404 });
    }
    const [existing] = await tx.select().from(meetingAudioEvaluations).where(and(
      eq(meetingAudioEvaluations.ownerUserId, principal.userId),
      eq(meetingAudioEvaluations.accountId, principal.accountId),
      eq(meetingAudioEvaluations.idempotencyKey, input.idempotencyKey.trim()),
    )).limit(1);
    if (existing) return { sample, evaluationId: existing.id, status: existing.status, created: false as const };
    const evaluationId = randomUUID();
    const [inserted] = await tx.insert(meetingAudioEvaluations).values({
      id: evaluationId,
      sampleId: sample.id,
      idempotencyKey: input.idempotencyKey.trim(),
      status: "running",
      environmentId: input.environmentId,
      bindingId: input.bindingId,
      originalRecognitionProvenance: sample.originalRecognitionProvenance,
      scope: "user",
      ownerUserId: principal.userId,
      accountId: principal.accountId,
      vaultId: sample.vaultId,
      createdByUserId: principal.userId,
    }).onConflictDoNothing().returning({ id: meetingAudioEvaluations.id });
    if (!inserted) {
      const [concurrent] = await tx.select().from(meetingAudioEvaluations).where(and(
        eq(meetingAudioEvaluations.ownerUserId, principal.userId),
        eq(meetingAudioEvaluations.accountId, principal.accountId),
        eq(meetingAudioEvaluations.idempotencyKey, input.idempotencyKey.trim()),
      )).limit(1);
      if (!concurrent) throw new Error("Evaluation idempotency conflict could not be resolved");
      return { sample, evaluationId: concurrent.id, status: concurrent.status, created: false as const };
    }
    return { sample, evaluationId, status: "running", created: true as const };
  });
  if (!prepared.created) return { evaluationId: prepared.evaluationId, status: prepared.status };
  const { sample, evaluationId } = prepared;
  const evaluationPrincipal = { ...principal, activeVaultId: sample.vaultId, visibleVaultIds: [sample.vaultId] };
  setImmediate(() => {
    void runEvaluation(evaluationId, sample, input.environmentId, input.bindingId, evaluationPrincipal).catch(async (error) => {
      await runWithPrincipal(evaluationPrincipal, async () => {
        await db.update(meetingAudioEvaluations).set({
          status: "failed",
          failureCode: safeFailureCode(error),
          completedAt: new Date(),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(meetingAudioEvaluations.id, evaluationId),
          eq(meetingAudioEvaluations.ownerUserId, sample.ownerUserId),
          eq(meetingAudioEvaluations.accountId, sample.accountId),
          eq(meetingAudioEvaluations.status, "running"),
        ));
      });
      log.error("Meeting audio evaluation failed", {
        evaluationId,
        sampleId: sample.id,
        environmentId: input.environmentId,
        bindingId: input.bindingId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    });
  });
  log.info("Meeting audio evaluation queued", { evaluationId, sampleId: sample.id, environmentId: input.environmentId, bindingId: input.bindingId });
  return { evaluationId, status: "running" };
}

export async function getMeetingAudioEvaluation(evaluationId: string) {
  const principal = requireUserPrincipal();
  const [evaluation] = await db.select({
    id: meetingAudioEvaluations.id,
    sampleId: meetingAudioEvaluations.sampleId,
    status: meetingAudioEvaluations.status,
    environmentId: meetingAudioEvaluations.environmentId,
    bindingId: meetingAudioEvaluations.bindingId,
    attemptId: meetingAudioEvaluations.attemptId,
    adapterKind: meetingAudioEvaluations.adapterKind,
    provider: meetingAudioEvaluations.provider,
    model: meetingAudioEvaluations.model,
    configFingerprint: meetingAudioEvaluations.configFingerprint,
    utteranceCount: meetingAudioEvaluations.utteranceCount,
    firstFinalLatencyMs: meetingAudioEvaluations.firstFinalLatencyMs,
    finalizationLatencyMs: meetingAudioEvaluations.finalizationLatencyMs,
    failureCode: meetingAudioEvaluations.failureCode,
    completedAt: meetingAudioEvaluations.completedAt,
  }).from(meetingAudioEvaluations).where(and(
    eq(meetingAudioEvaluations.id, evaluationId),
    eq(meetingAudioEvaluations.scope, "user"),
    eq(meetingAudioEvaluations.ownerUserId, principal.userId),
    eq(meetingAudioEvaluations.accountId, principal.accountId),
    inArray(meetingAudioEvaluations.vaultId, principal.visibleVaultIds),
  )).limit(1);
  return evaluation || null;
}

export async function purgeExpiredMeetingAudio(): Promise<number> {
  const expired = await runWithPrincipal(
    createNamedSystemPrincipal("meeting-audio-expiry", ["system:read"]),
    () => db.select().from(meetingAudioSamples).where(and(
      inArray(meetingAudioSamples.status, ["recording", "ready", "failed"]),
      lt(meetingAudioSamples.expiresAt, new Date()),
    )).limit(EXPIRY_BATCH_SIZE),
  );
  let purged = 0;
  for (const sample of expired) {
    try {
      await runWithMeetingOwnerIdentity({ ownerUserId: sample.ownerUserId, accountId: sample.accountId, vaultId: sample.vaultId }, async () => {
        if (sampleVisibleToPrincipal(sample, requireUserPrincipal())) {
          const deleted = await deleteMeetingAudioSample(sample.id, "expired");
          if (deleted) purged += 1;
        }
      });
    } catch (error) {
      log.warn("Expired meeting audio purge deferred", { sampleId: sample.id, errorType: error instanceof Error ? error.name : typeof error });
    }
  }
  return purged;
}
