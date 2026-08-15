// Use createLogger for logging ONLY
import { db, fnv1a32 } from "./db";
import { createLogger } from "./log";
import {
  users, skills, skillReferences, skillRevisions, skillRuns, skillFailureDismissals, skillPersonaPreferences, promptModules, promptModuleVersions, systemSettings, insertSkillSchema,
  voiceSessionActive,
  emailTriageLog, emailMessages, emailSyncLog, emailSyncCursors, emailDrafts,
  emailEnrichments, emailDismissals, connectedAccounts,
  type User, type InsertUser,
  type ApiCall, type InsertApiCall,

  type Issue, type InsertIssue,
  type Skill, type SkillReference, type InsertSkill, type SkillWithReferences,
  type CheckResult,
  type SkillRun, type SkillRunStatus,
  type PromptModule, type PromptModuleVersion, type InsertPromptModule, type UpdatePromptModule,
  type VoiceSessionActive,
  type EmailTriageLog, type InsertEmailTriageLog,
  type EmailMessage, type InsertEmailMessage,
  type EmailSyncLog, type InsertEmailSyncLog,
  type EmailDraft, type InsertEmailDraft,
  type EmailEnrichment, type InsertEmailEnrichment,
  type EmailDismissal, type InsertEmailDismissal,
} from "@shared/schema";
import { eq, ne, desc, gte, count, sql, inArray, or, lte, and, isNotNull, type SQL } from "drizzle-orm";
import { fileIssueStorage, fileApiCallStorage } from "./file-storage";
import { peopleStorage } from "./people-storage";
import {
  skillRevisionPayload,
  skillPayloadHash,
  changedSkillFields,
  compareSkillVersions,
  codeCatalogSkillInputs,
  SKILL_PAYLOAD_FIELDS,
  type SkillRevisionPayload,
} from "./skill-seed";
import { randomUUID } from "node:crypto";
import { getCurrentPrincipal, requireCurrentPrincipal } from "./principal-context";
import { principalHasPermission } from "./permissions";
import type { Principal } from "./principal";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { combineWithSensitiveVisible, combineWithSensitiveWritable, sensitiveOwnershipValues } from "./sensitive-scope";

const emailMessageScopeColumns = { ownerUserId: emailMessages.ownerUserId, principalAccountId: emailMessages.principalAccountId };
// emailDraftScopeColumns removed — draft storage moved to email-draft-storage.ts
const emailSyncLogScopeColumns = { ownerUserId: emailSyncLog.ownerUserId, principalAccountId: emailSyncLog.principalAccountId };
const emailSyncCursorScopeColumns = { ownerUserId: emailSyncCursors.ownerUserId, principalAccountId: emailSyncCursors.principalAccountId };
const emailEnrichmentScopeColumns = { ownerUserId: emailEnrichments.ownerUserId, principalAccountId: emailEnrichments.principalAccountId };
const emailDismissalScopeColumns = { ownerUserId: emailDismissals.ownerUserId, principalAccountId: emailDismissals.principalAccountId };
const connectedAccountScopeColumns = { ownerUserId: connectedAccounts.ownerUserId, principalAccountId: connectedAccounts.principalAccountId };

export type VoiceLeaseMutationAuthority =
  | { kind: "process"; bootId: string }
  | { kind: "user"; principal: Principal };

export type VoiceLeaseClaimResult =
  | { outcome: "claimed"; lease: VoiceSessionActive; replacedSessionId: string | null }
  | { outcome: "existing"; lease: VoiceSessionActive }
  | { outcome: "conflict"; lease: VoiceSessionActive };

function voiceLeaseWritablePredicate(sessionId: string, authority: VoiceLeaseMutationAuthority): SQL {
  if (authority.kind === "process") {
    return and(
      eq(voiceSessionActive.sessionId, sessionId),
      eq(voiceSessionActive.bootId, authority.bootId),
    )!;
  }
  const { principal } = authority;
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    return sql`FALSE`;
  }
  return and(
    eq(voiceSessionActive.sessionId, sessionId),
    eq(voiceSessionActive.scope, "user"),
    eq(voiceSessionActive.ownerUserId, principal.userId),
    eq(voiceSessionActive.accountId, principal.accountId),
  )!;
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByInviteToken(token: string): Promise<User | undefined>;
  getUserByResetToken(token: string): Promise<User | undefined>;
  getUsers(): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  createInitialAdmin(user: InsertUser): Promise<User | null>;
  updateUser(id: string, updates: Partial<Omit<User, "id">>): Promise<User | undefined>;
  getUserCount(): Promise<number>;

  createApiCall(call: InsertApiCall): Promise<ApiCall>;
  settleApiCall(id: number, call: InsertApiCall): Promise<ApiCall | undefined>;
  getApiCalls(limit?: number, offset?: number, since?: Date): Promise<ApiCall[]>;
  getApiCall(id: number): Promise<ApiCall | undefined>;
  getApiCallSummary(since?: Date): Promise<{
    totalCalls: number;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
  }>;
  getApiCallsByDay(since?: Date, tz?: string): Promise<Array<{ date: string; calls: number; cost: number; tokens: number }>>;
  getApiCallsByHour(since?: Date, tz?: string): Promise<Array<{ hour: string; calls: number; cost: number; tokens: number }>>;
  getApiCallsByModel(since?: Date): Promise<Array<{ provider: string; model: string; calls: number; cost: number; tokens: number; avgDuration: number | null; inputTokens: number; outputTokens: number }>>;
  getApiCallsByModelByDay(since?: Date, tz?: string): Promise<Array<{ date: string; model: string; cost: number; tokens: number; inputTokens: number; outputTokens: number }>>;
  getApiCallsByModelByHour(since?: Date, tz?: string): Promise<Array<{ hour: string; model: string; cost: number; tokens: number; inputTokens: number; outputTokens: number }>>;
  getApiCallsByProfile(since?: Date): Promise<Array<{ profile: string; calls: number; cost: number; tokens: number }>>;
  getTotalApiCallCount(): Promise<number>;

  getIssues(options?: { status?: string; excludeStatus?: string; lightweight?: boolean }): Promise<Issue[] | Partial<Issue>[]>;
  getIssuesForAdmin(principal: Principal, options?: { status?: string; excludeStatus?: string; lightweight?: boolean }): Promise<Issue[] | Partial<Issue>[]>;
  getIssue(id: number): Promise<Issue | undefined>;
  getIssueForAdmin(principal: Principal, id: number): Promise<Issue | undefined>;
  createIssue(issue: InsertIssue): Promise<Issue>;
  updateIssue(id: number, updates: Partial<InsertIssue>): Promise<Issue | undefined>;
  updateIssueForAdmin(principal: Principal, id: number, updates: Partial<InsertIssue>): Promise<Issue | undefined>;
  resolveIssueWithEvidence(id: number, note: string): Promise<Issue | undefined>;
  resolveIssueWithEvidenceForAdmin(principal: Principal, id: number, note: string): Promise<Issue | undefined>;
  addIssueNote(id: number, text: string, author?: "user" | "agent"): Promise<Issue | undefined>;
  addIssueNoteForAdmin(principal: Principal, id: number, text: string, author?: "user" | "agent"): Promise<Issue | undefined>;
  deleteIssue(id: number): Promise<boolean>;
  deleteIssueForAdmin(principal: Principal, id: number): Promise<boolean>;

  getGmailSkipList(): Promise<{ email: string; name?: string; skippedAt: string }[]>;
  addToGmailSkipList(entries: { email: string; name?: string }[]): Promise<void>;
  removeFromGmailSkipList(emails: string[]): Promise<void>;

  getPromptModules(filters?: { status?: string; domain?: string }): Promise<PromptModule[]>;
  getPromptModule(id: string): Promise<PromptModule | undefined>;
  getPromptModuleByKey(key: string): Promise<PromptModule | undefined>;
  createPromptModule(data: InsertPromptModule): Promise<PromptModule>;
  updatePromptModule(id: string, data: UpdatePromptModule, changeNote?: string): Promise<PromptModule | undefined>;
  deletePromptModule(id: string): Promise<boolean>;
  getPromptModuleVersions(moduleId: string): Promise<PromptModuleVersion[]>;
  restorePromptModuleVersion(moduleId: string, versionId: number): Promise<PromptModule | undefined>;

  getSkills(filters?: { status?: string; category?: string }): Promise<SkillWithReferences[]>;
  getSkill(id: string): Promise<SkillWithReferences | undefined>;
  getSkillByName(name: string): Promise<SkillWithReferences | undefined>;
  createSkill(data: InsertSkill): Promise<SkillWithReferences>;
  updateSkill(id: string, data: Partial<InsertSkill>): Promise<SkillWithReferences | undefined>;
  deleteSkill(id: string): Promise<boolean>;
  // Skill Default Lattice mutations (Persona morphogenic layer mirror).
  ensureOwnedSkillCopy(id: string): Promise<SkillWithReferences | undefined>;
  revertSkillOverride(id: string): Promise<SkillWithReferences | undefined>;
  useUpdatedSkillDefault(id: string): Promise<SkillWithReferences | undefined>;
  acknowledgeSkillUpdate(id: string): Promise<SkillWithReferences | undefined>;
  previewPlatformSkillPublication(
    id: string,
    input: Partial<SkillRevisionPayload>,
  ): Promise<{
    template: SkillWithReferences;
    payload: SkillRevisionPayload;
    changedFields: string[];
    impact: { advancing: number; updateAvailable: number };
  } | null>;
  publishPlatformSkillRevision(
    id: string,
    input: Partial<SkillRevisionPayload>,
    changeSummary: string,
    confirmed: boolean,
  ): Promise<SkillWithReferences | undefined>;
  healLeftoverSkillFollowers(): Promise<{ healed: number; abstained: number }>;
  syncSkillCatalogToLattice(): Promise<{
    published: number;
    advancedFollowers: number;
    offered: number;
    skipped: number;
    downgradeGuarded: number;
  }>;
  incrementSkillSuccess(id: string): Promise<void>;
  incrementSkillFailure(id: string): Promise<void>;
  // insertSkillScore, getLatestSkillScore, getSkillScores, getSkillLastRuns removed — skill_scores superseded by skill_runs
  getSkillFailedNames(): Promise<{ name: string; scoredAt: string }[]>;
  dismissSkillFailure(skillName: string): Promise<void>;

  insertSkillRun(data: {
    skillName: string;
    sessionId: string;
    status?: SkillRunStatus;
    parentSessionId?: string;
    parentSkillRunId?: number;
    parentToolCallId?: string;
    runtimeRunId?: string;
  }): Promise<SkillRun>;
  updateSkillRunStatus(sessionId: string, status: SkillRunStatus, durationMs?: number, failureReason?: string): Promise<SkillRun | null>;
  reconcileSkillRunStatus(sessionId: string, fromStatus: SkillRunStatus, toStatus: SkillRunStatus, failureReason: string): Promise<SkillRun | null>;
  updateSkillRunScore(sessionId: string, data: {
    passRate: number;
    checklistTotal: number;
    checklistPassed: number;
    checklistResults: CheckResult[];
    comparativeVsId?: number | null;
    comparativeWinner?: "current" | "prior" | "tie" | null;
    comparativeReason?: string | null;
  }): Promise<SkillRun | null>;
  getSkillRunBySessionId(sessionId: string): Promise<SkillRun | null>;
  getSkillRunByRuntimeRunId(runtimeRunId: string): Promise<SkillRun | null>;
  getChildSkillRunsByParent(parentSkillRunId: number): Promise<SkillRun[]>;
  getSkillRuns(skillName: string, limit?: number): Promise<SkillRun[]>;
  getSkillRunLastRuns(): Promise<Record<string, string>>;
  getLatestScoredSkillRun(skillName: string): Promise<SkillRun | null>;
  healStuckSkillRuns(): Promise<number>;
  dismissLogErrors(): Promise<void>;
  getLogErrorDismissedAt(): Promise<string | null>;



  claimVoiceSessionActive(input: { sessionId: string; chatSessionId: string; requestId: string; bootId: string; principal: Principal; reconnect: boolean }): Promise<VoiceLeaseClaimResult>;
  claimProvisionalVoiceSessionActive(input: { sessionId: string; capabilityKey: string; requestId: string; bootId: string }): Promise<VoiceLeaseClaimResult>;
  getProvisionalVoiceSessionStartByRequest(requestId: string, capabilityKey: string): Promise<VoiceSessionActive | undefined>;
  completeVoiceSessionStart(sessionId: string, bootId: string, response: Record<string, unknown>): Promise<VoiceSessionActive | undefined>;
  getVoiceSessionStartByRequest(requestId: string, principal: Principal): Promise<VoiceSessionActive | undefined>;
  getOwnedActiveVoiceSession(sessionId: string, bootId: string): Promise<VoiceSessionActive | undefined>;
  endVoiceSessionActive(sessionId: string, status: "complete" | "abandoned", authority: VoiceLeaseMutationAuthority): Promise<void>;
  completeOwnedVoiceSession(
    sessionId: string,
    chatSessionId: string,
    principal: Principal,
  ): Promise<"completed" | "already_complete" | "superseded" | "not_completable">;
  abandonOwnedVoiceSession(
    sessionId: string,
    chatSessionId: string,
    principal: Principal,
  ): Promise<"abandoned" | "already_terminal" | "not_owned">;
  updateVoiceSessionInflight(sessionId: string, inflightTurn: number, bootId: string): Promise<void>;
  clearVoiceSessionInflight(sessionId: string, bootId: string): Promise<void>;
  abandonExpiredVoiceSessions(staleBefore: Date): Promise<VoiceSessionActive[]>;
  getActiveVoiceSessions(bootId: string): Promise<VoiceSessionActive[]>;
  pruneVoiceSessions(retentionDays: number): Promise<{ deleted: number; remaining: number }>;

  getTriagedMessageIds(sinceHours?: number): Promise<string[]>;
  getTriageLog(sinceHours?: number): Promise<EmailTriageLog[]>;
  recordTriagedEmail(entry: InsertEmailTriageLog): Promise<EmailTriageLog>;
  recordTriagedEmails(entries: InsertEmailTriageLog[]): Promise<void>;

  getUntriagedCachedEmails(limit?: number): Promise<EmailMessage[]>;
  getOpenCachedMessagesForReconcile(accountId: string, limit: number): Promise<EmailMessage[]>;
  reconcileExternalArchive(messageId: number, reason: string): Promise<void>;
  touchOpenCachedMessages(messageIds: number[]): Promise<void>;
  updateEmailTriageState(id: number, tier: string, reason: string): Promise<EmailMessage | undefined>;
  batchUpdateEmailTriageState(updates: Array<{ id: number; tier: string; reason: string }>): Promise<Array<{ accountId: string; providerMessageId: string }>>;
  markEmailDone(id: number, done: boolean): Promise<EmailMessage | undefined>;
  getCachedEmailById(id: number): Promise<EmailMessage | undefined>;
  deleteCachedEmail(id: number): Promise<boolean>;
  getCachedEmailByProviderIdAndAccount(providerMessageId: string, accountId: string): Promise<EmailMessage | undefined>;

  recordSyncStart(accountId: string, resyncReason?: string): Promise<EmailSyncLog>;
  recordSyncComplete(syncId: number, messagesSynced: number, cursorState?: string, reconciledCount?: number): Promise<EmailSyncLog | undefined>;
  recordSyncError(syncId: number, errorMessage: string): Promise<EmailSyncLog | undefined>;
  getLastSuccessfulSync(accountId: string): Promise<EmailSyncLog | undefined>;
  getSyncHealth(): Promise<Array<{ accountId: string; lastSuccess: Date | null; lastError: string | null; totalSynced: number; totalReconciled: number; orphaned: boolean }>>;
  cleanupEmailAccountState(accountId: string): Promise<{ accountId: string; deleted: Record<string, number> }>;

  // Email draft storage moved to server/email-draft-storage.ts

  getUnenrichedTriagedEmails(limit?: number): Promise<EmailMessage[]>;
  getEmailPipelineCounts(): Promise<{ untriaged: number; awaitingEnrichment: number; reviewReady: number }>;
  getLastEmailEnrichment(): Promise<EmailEnrichment | undefined>;
  upsertEmailEnrichment(data: InsertEmailEnrichment): Promise<EmailEnrichment>;
  getEnrichmentsByThreadIds(threadIds: string[], accountId?: string): Promise<EmailEnrichment[]>;
  recordEmailDismissal(data: InsertEmailDismissal): Promise<EmailDismissal>;
  getEmailHistory(filters: { startDate?: Date; endDate?: Date; type?: string }): Promise<EmailDismissal[]>;
}

const log = createLogger("Storage");
const skillScopeColumns = { scope: skills.scope, ownerUserId: skills.ownerUserId, accountId: skills.accountId, vaultId: skills.vaultId };

/** Exact Drizzle transaction handle type used by the skill lattice helpers. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Whole-field overlay of a partial skill payload input onto a base payload.
 * Only defined fields override — omitted/undefined inputs are "no change", never
 * destructive. Whole-field replace only; process text is never AI-merged.
 */
function mergeSkillPayloadInput(
  base: SkillRevisionPayload,
  input: Partial<SkillRevisionPayload>,
): SkillRevisionPayload {
  const merged: SkillRevisionPayload = { ...base };
  for (const field of SKILL_PAYLOAD_FIELDS) {
    const value = input[field];
    if (value !== undefined) {
      (merged as Record<string, unknown>)[field] = value;
    }
  }
  return merged;
}
const promptModuleScopeColumns = { scope: promptModules.scope, ownerUserId: promptModules.ownerUserId, accountId: promptModules.accountId };
const skillRunScopeColumns = { ownerUserId: skillRuns.ownerUserId, accountId: skillRuns.accountId, vaultId: skillRuns.vaultId };
// skillScoreScopeColumns removed — skill_scores superseded by skill_runs
const skillDismissalScopeColumns = { ownerUserId: skillFailureDismissals.ownerUserId, accountId: skillFailureDismissals.accountId };

export class HybridStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async getUserByInviteToken(token: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.inviteToken, token));
    return user;
  }

  async getUserByResetToken(token: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.resetToken, token));
    return user;
  }

  async getUsers(): Promise<User[]> {
    return db.select().from(users).orderBy(desc(users.createdAt));
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async createInitialAdmin(insertUser: InsertUser): Promise<User | null> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('mantra.initial-admin'))`);
      const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
      if (existing) return null;
      const [user] = await tx.insert(users).values({ ...insertUser, role: "admin" }).returning();
      return user ?? null;
    });
  }

  async updateUser(id: string, updates: Partial<Omit<User, "id">>): Promise<User | undefined> {
    const [user] = await db.update(users).set(updates).where(eq(users.id, id)).returning();
    return user;
  }

  async getUserCount(): Promise<number> {
    const [result] = await db.select({ count: count() }).from(users);
    return result?.count || 0;
  }


  async createApiCall(call: InsertApiCall): Promise<ApiCall> {
    return fileApiCallStorage.createApiCall(call);
  }

  async settleApiCall(id: number, call: InsertApiCall): Promise<ApiCall | undefined> {
    return fileApiCallStorage.settleApiCall(id, call);
  }

  async getApiCalls(limit = 50, offset = 0, since?: Date): Promise<ApiCall[]> {
    return fileApiCallStorage.getApiCalls(limit, offset, since);
  }

  async getApiCall(id: number): Promise<ApiCall | undefined> {
    return fileApiCallStorage.getApiCall(id);
  }

  async getApiCallSummary(since?: Date) {
    return fileApiCallStorage.getApiCallSummary(since);
  }

  async getApiCallsByDay(since?: Date, tz?: string) {
    return fileApiCallStorage.getApiCallsByDay(since, tz);
  }

  async getApiCallsByHour(since?: Date, tz?: string) {
    return fileApiCallStorage.getApiCallsByHour(since, tz);
  }

  async getApiCallsByModel(since?: Date) {
    return fileApiCallStorage.getApiCallsByModel(since);
  }

  async getApiCallsByModelByDay(since?: Date, tz?: string) {
    return fileApiCallStorage.getApiCallsByModelByDay(since, tz);
  }

  async getApiCallsByModelByHour(since?: Date, tz?: string) {
    return fileApiCallStorage.getApiCallsByModelByHour(since, tz);
  }

  async getApiCallsByProfile(since?: Date) {
    return fileApiCallStorage.getApiCallsByProfile(since);
  }

  async getTotalApiCallCount(): Promise<number> {
    return fileApiCallStorage.getTotalApiCallCount();
  }

  async getIssues(options?: { status?: string; excludeStatus?: string; lightweight?: boolean }): Promise<Issue[] | Partial<Issue>[]> {
    return fileIssueStorage.getIssues(options);
  }

  async getIssuesForAdmin(principal: Principal, options?: { status?: string; excludeStatus?: string; lightweight?: boolean }): Promise<Issue[] | Partial<Issue>[]> {
    return fileIssueStorage.getIssuesForAdmin(principal, options);
  }

  async getIssue(id: number): Promise<Issue | undefined> {
    return fileIssueStorage.getIssue(id);
  }

  async getIssueForAdmin(principal: Principal, id: number): Promise<Issue | undefined> {
    return fileIssueStorage.getIssueForAdmin(principal, id);
  }

  async createIssue(issue: InsertIssue): Promise<Issue> {
    return fileIssueStorage.createIssue(issue);
  }

  async updateIssue(id: number, updates: Partial<InsertIssue>): Promise<Issue | undefined> {
    return fileIssueStorage.updateIssue(id, updates);
  }

  async updateIssueForAdmin(principal: Principal, id: number, updates: Partial<InsertIssue>): Promise<Issue | undefined> {
    return fileIssueStorage.updateIssueForAdmin(principal, id, updates);
  }

  async resolveIssueWithEvidence(id: number, note: string): Promise<Issue | undefined> {
    return fileIssueStorage.resolveWithEvidence(id, note);
  }

  async resolveIssueWithEvidenceForAdmin(principal: Principal, id: number, note: string): Promise<Issue | undefined> {
    return fileIssueStorage.resolveWithEvidenceForAdmin(principal, id, note);
  }

  async addIssueNote(id: number, text: string, author: "user" | "agent" = "agent"): Promise<Issue | undefined> {
    return fileIssueStorage.addNote(id, text, author);
  }

  async addIssueNoteForAdmin(principal: Principal, id: number, text: string, author: "user" | "agent" = "agent"): Promise<Issue | undefined> {
    return fileIssueStorage.addNoteForAdmin(principal, id, text, author);
  }

  async deleteIssue(id: number): Promise<boolean> {
    return fileIssueStorage.deleteIssue(id);
  }

  async deleteIssueForAdmin(principal: Principal, id: number): Promise<boolean> {
    return fileIssueStorage.deleteIssueForAdmin(principal, id);
  }

  async getGmailSkipList(): Promise<{ email: string; name?: string; skippedAt: string }[]> {
    return peopleStorage.getGmailSkipList();
  }

  async addToGmailSkipList(entries: { email: string; name?: string }[]): Promise<void> {
    return peopleStorage.addToGmailSkipList(entries);
  }

  async removeFromGmailSkipList(emails: string[]): Promise<void> {
    return peopleStorage.removeFromGmailSkipList(emails);
  }

  private computeTrustScore(successCount: number, failureCount: number): number {
    const denominator = successCount + failureCount * 3;
    if (denominator === 0) return 0;
    return Math.round((successCount / denominator) * 100) / 100;
  }

  private skillVisible(predicate?: SQL): SQL {
    const principal = requireCurrentPrincipal();
    const scoped = combineWithVisibleScope(principal, skillScopeColumns, predicate);
    if (principal.actorType === "system") return scoped;
    if (!principal.userId || !principal.accountId) return sql`FALSE`;
    return and(scoped, or(
      eq(skills.scope, "global"),
      and(
        eq(skills.scope, "user"),
        eq(skills.ownerUserId, principal.userId),
        eq(skills.accountId, principal.accountId),
      ),
    ))!;
  }

  private skillWritable(predicate?: SQL): SQL {
    const principal = requireCurrentPrincipal();
    if (principal.actorType === "system") return predicate ?? sql`TRUE`;
    if (!principal.userId || !principal.accountId) return sql`FALSE`;
    return and(
      combineWithWritableScope(principal, skillScopeColumns, predicate),
      eq(skills.scope, "user"),
      eq(skills.ownerUserId, principal.userId),
      eq(skills.accountId, principal.accountId),
    )!;
  }

  private promptModuleVisible(predicate?: SQL): SQL {
    return combineWithVisibleScope(requireCurrentPrincipal(), promptModuleScopeColumns, predicate);
  }

  private promptModuleWritable(predicate?: SQL): SQL {
    const principal = requireCurrentPrincipal();
    if (principalHasPermission(principal, "build:write") || principalHasPermission(principal, "system:write")) {
      return predicate ?? sql`TRUE`;
    }
    return combineWithWritableScope(principal, promptModuleScopeColumns, predicate);
  }

  private runVisible(predicate?: SQL): SQL {
    const principal = requireCurrentPrincipal();
    const scoped = combineWithVisibleScope(principal, skillRunScopeColumns, predicate);
    if (principal.actorType === "system") return scoped;
    if (!principal.userId || !principal.accountId) return sql`FALSE`;
    return and(
      scoped,
      eq(skillRuns.ownerUserId, principal.userId),
      eq(skillRuns.accountId, principal.accountId),
    )!;
  }

  private runWritable(predicate?: SQL): SQL {
    const principal = requireCurrentPrincipal();
    const scoped = combineWithWritableScope(principal, skillRunScopeColumns, predicate);
    if (principal.actorType === "system") return scoped;
    if (!principal.userId || !principal.accountId) return sql`FALSE`;
    return and(
      scoped,
      eq(skillRuns.ownerUserId, principal.userId),
      eq(skillRuns.accountId, principal.accountId),
    )!;
  }

  private dismissalVisible(predicate?: SQL): SQL {
    const principal = requireCurrentPrincipal();
    const scoped = combineWithVisibleScope(principal, skillDismissalScopeColumns, predicate);
    if (principal.actorType === "system") return scoped;
    if (!principal.userId || !principal.accountId) return sql`FALSE`;
    return and(
      scoped,
      eq(skillFailureDismissals.ownerUserId, principal.userId),
      eq(skillFailureDismissals.accountId, principal.accountId),
    )!;
  }

  private async enrichSkillWithReferences(skill: Skill): Promise<SkillWithReferences> {
    const refs = await db.select().from(skillReferences).where(eq(skillReferences.skillId, skill.id));
    return {
      ...skill,
      references: refs,
      trustScore: this.computeTrustScore(skill.successCount, skill.failureCount),
    };
  }


  private promptModuleSnapshotValues(module: PromptModule, changeNote?: string): typeof promptModuleVersions.$inferInsert {
    return {
      moduleId: module.id,
      key: module.key,
      name: module.name,
      description: module.description,
      domain: module.domain,
      prompt: module.prompt,
      outputSpec: module.outputSpec,
      outputSchema: module.outputSchema,
      status: module.status,
      version: module.version,
      sourceSkillName: module.sourceSkillName,
      metadata: module.metadata,
      changeNote: changeNote ?? null,
    };
  }

  async getPromptModules(filters?: { status?: string; domain?: string }): Promise<PromptModule[]> {
    const conditions = [];
    if (filters?.status) conditions.push(eq(promptModules.status, filters.status));
    if (filters?.domain) conditions.push(eq(promptModules.domain, filters.domain));
    const predicate = conditions.length > 0 ? and(...conditions) : undefined;
    return db.select().from(promptModules).where(this.promptModuleVisible(predicate)).orderBy(desc(promptModules.updatedAt));
  }

  async getPromptModule(id: string): Promise<PromptModule | undefined> {
    const [module] = await db.select().from(promptModules).where(this.promptModuleVisible(eq(promptModules.id, id)));
    return module;
  }

  async getPromptModuleByKey(key: string): Promise<PromptModule | undefined> {
    const [module] = await db.select().from(promptModules).where(this.promptModuleVisible(eq(promptModules.key, key)));
    return module;
  }

  async createPromptModule(data: InsertPromptModule): Promise<PromptModule> {
    const [created] = await db.insert(promptModules).values({
      ...ownedInsertValues(requireCurrentPrincipal(), promptModuleScopeColumns),
      ...data,
    }).returning();
    await db.insert(promptModuleVersions).values(this.promptModuleSnapshotValues(created, "created"));
    return created;
  }

  async updatePromptModule(id: string, data: UpdatePromptModule, changeNote?: string): Promise<PromptModule | undefined> {
    return db.transaction(async (tx) => {
      const [existing] = await tx.select().from(promptModules).where(this.promptModuleWritable(eq(promptModules.id, id)));
      if (!existing) return undefined;
      await tx.insert(promptModuleVersions).values(this.promptModuleSnapshotValues(existing, changeNote ?? "before update")).onConflictDoNothing();
      const [updated] = await tx.update(promptModules)
        .set({ ...data, updatedAt: new Date() })
        .where(this.promptModuleWritable(eq(promptModules.id, id)))
        .returning();
      return updated;
    });
  }

  async deletePromptModule(id: string): Promise<boolean> {
    const [deleted] = await db.delete(promptModules).where(this.promptModuleWritable(eq(promptModules.id, id))).returning();
    return !!deleted;
  }

  async getPromptModuleVersions(moduleId: string): Promise<PromptModuleVersion[]> {
    const module = await this.getPromptModule(moduleId);
    if (!module) return [];
    return db.select().from(promptModuleVersions).where(eq(promptModuleVersions.moduleId, moduleId)).orderBy(desc(promptModuleVersions.createdAt));
  }

  async restorePromptModuleVersion(moduleId: string, versionId: number): Promise<PromptModule | undefined> {
    return db.transaction(async (tx) => {
      const [existing] = await tx.select().from(promptModules).where(this.promptModuleWritable(eq(promptModules.id, moduleId)));
      if (!existing) return undefined;
      const [version] = await tx.select().from(promptModuleVersions)
        .where(and(eq(promptModuleVersions.moduleId, moduleId), eq(promptModuleVersions.id, versionId)));
      if (!version) return undefined;
      await tx.insert(promptModuleVersions).values(this.promptModuleSnapshotValues(existing, `before restore ${versionId}`)).onConflictDoNothing();
      const [restored] = await tx.update(promptModules).set({
        name: version.name,
        description: version.description,
        domain: version.domain,
        prompt: version.prompt,
        outputSpec: version.outputSpec,
        outputSchema: version.outputSchema,
        status: version.status,
        version: version.version,
        sourceSkillName: version.sourceSkillName,
        metadata: version.metadata,
        updatedAt: new Date(),
      }).where(this.promptModuleWritable(eq(promptModules.id, moduleId))).returning();
      return restored;
    });
  }

  async getSkills(filters?: { status?: string; category?: string }): Promise<SkillWithReferences[]> {
    const conditions = [];
    if (filters?.status) conditions.push(eq(skills.status, filters.status));
    if (filters?.category) conditions.push(eq(skills.category, filters.category));

    const predicate = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await db.select().from(skills).where(this.skillVisible(predicate)).orderBy(desc(skills.updatedAt));
    const principal = requireCurrentPrincipal();
    const effectiveRows = principal.actorType === "user"
      ? [...rows]
          .sort((left, right) => {
            const leftOwned = left.scope === "user" && left.ownerUserId === principal.userId && left.accountId === principal.accountId;
            const rightOwned = right.scope === "user" && right.ownerUserId === principal.userId && right.accountId === principal.accountId;
            return Number(rightOwned) - Number(leftOwned);
          })
          .filter((row, index, all) => all.findIndex((candidate) => candidate.name === row.name) === index)
      : rows;
    return Promise.all(effectiveRows.map(s => this.enrichSkillWithReferences(s)));
  }

  async getSkill(id: string): Promise<SkillWithReferences | undefined> {
    const [skill] = await db.select().from(skills).where(this.skillVisible(eq(skills.id, id)));
    if (!skill) return undefined;
    return this.enrichSkillWithReferences(skill);
  }

  async getSkillByName(name: string): Promise<SkillWithReferences | undefined> {
    const principal = requireCurrentPrincipal();
    const namespaceOrder = principal.actorType === "user" && principal.userId && principal.accountId
      ? sql`CASE
          WHEN ${skills.scope} = 'user'
            AND ${skills.ownerUserId} = ${principal.userId}
            AND ${skills.accountId} = ${principal.accountId}
          THEN 0
          WHEN ${skills.scope} = 'global' THEN 1
          ELSE 2
        END`
      : sql`CASE WHEN ${skills.scope} = 'global' THEN 0 ELSE 1 END`;
    const rows = await db
      .select()
      .from(skills)
      .where(this.skillVisible(eq(skills.name, name)))
      .orderBy(namespaceOrder, desc(skills.updatedAt))
      .limit(1);
    const skill = rows[0];
    if (!skill) return undefined;
    return this.enrichSkillWithReferences(skill);
  }

  async createSkill(data: InsertSkill): Promise<SkillWithReferences> {
    const principal = getCurrentPrincipal();
    if (!principal?.userId || !principal.accountId) {
      throw new Error("Skill creation requires an explicit user principal");
    }
    const normalized = insertSkillSchema.parse(data);
    const { references: refs, scope: _scope, ownerUserId: _ownerUserId, accountId: _accountId, vaultId: _vaultId, ...skillData } = normalized;
    const [created] = await db.insert(skills).values({
      ...skillData,
      author: skillData.author === "system" ? "user" : skillData.author,
      allowedTools: [],
      ...ownedInsertValues(principal, skillScopeColumns),
    }).returning();
    if (refs && refs.length > 0) {
      await db.insert(skillReferences).values(
        refs.map(r => ({ skillId: created.id, name: r.name, content: r.content }))
      );
    }
    return this.enrichSkillWithReferences(created);
  }

  async updateSkill(id: string, data: Partial<InsertSkill>): Promise<SkillWithReferences | undefined> {
    const principal = getCurrentPrincipal();
    if (!principal?.userId || !principal.accountId) {
      throw new Error("Skill updates require an explicit user principal");
    }
    const { references: refs, scope: _scope, ownerUserId: _ownerUserId, accountId: _accountId, vaultId: _vaultId, author: _author, ...skillData } = data;
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`skill-override:${principal.accountId}:${principal.userId}`}))`);
      const [visible] = await tx.select().from(skills).where(this.skillVisible(eq(skills.id, id)));
      if (!visible) return undefined;

      let target = visible;
      if (visible.scope === "global") {
        const [existingOverride] = await tx.select().from(skills).where(and(
          eq(skills.scope, "user"),
          eq(skills.ownerUserId, principal.userId),
          eq(skills.accountId, principal.accountId),
          eq(skills.name, visible.name),
        ));
        if (existingOverride) {
          target = existingOverride;
        } else {
          // Lattice cut 2: fork a *following* user copy of the seed. Never edit
          // the seed. The edit below writes the first user revision and flips to
          // customized, so a fork always carries lineage + recoverable history.
          target = await this.forkFollowingSkillCopyTx(tx, visible, {
            userId: principal.userId,
            accountId: principal.accountId,
            vaultId: principal.activeVaultId,
          });
        }
      }

      const [applied] = await tx.update(skills)
        .set({ ...skillData, updatedAt: new Date() })
        .where(this.skillWritable(eq(skills.id, target.id)))
        .returning();
      if (!applied) return undefined;
      if (refs !== undefined) {
        await tx.delete(skillReferences).where(eq(skillReferences.skillId, target.id));
        if (refs.length > 0) {
          await tx.insert(skillReferences).values(
            refs.map(r => ({ skillId: target.id, name: r.name, content: r.content }))
          );
        }
      }
      // Lattice cut 2: an edit is a user customization. Snapshot the edited
      // payload as an immutable user revision and advance updateState so the
      // freeze is a stage (customized) that publish can still offer inbound to.
      const newPayload = await this.buildSkillPayloadTx(tx, applied);
      const priorPayload = await this.readSkillRevisionPayloadTx(tx, applied.currentRevisionId);
      const summary = priorPayload
        ? `Updated ${changedSkillFields(priorPayload, newPayload).join(", ") || "skill"}`
        : "Customized skill";
      const revisionId = await this.insertSkillRevisionTx(tx, applied, newPayload, {
        scope: "user",
        parentRevisionId: applied.currentRevisionId ?? null,
        platformBaseRevisionId: applied.baseRevisionId ?? null,
        changeSummary: summary,
        createdByUserId: principal.userId,
      });
      const [finalRow] = await tx.update(skills)
        .set({
          currentRevisionId: revisionId,
          updateState: "customized",
          customized: true,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, target.id))
        .returning();
      return finalRow ?? applied;
    });
    if (!updated) return undefined;
    return this.enrichSkillWithReferences(updated);
  }

  /**
   * Fork a following user copy of a global skill for a principal. Shared by
   * updateSkill and ensureOwnedSkillCopy so the copy shape lives in one place.
   * The copy starts `following` the template's current revision; callers that
   * edit it write the first user revision and flip it to `customized`.
   */
  private async forkFollowingSkillCopyTx(
    tx: DbTransaction,
    visible: typeof skills.$inferSelect,
    owner: { userId: string; accountId: string; vaultId: string | null | undefined },
  ): Promise<typeof skills.$inferSelect> {
    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      successCount: _successCount,
      failureCount: _failureCount,
      scope: _scope,
      ownerUserId: _ownerUserId,
      accountId: _accountId,
      vaultId: _vaultId,
      templateSkillId: _templateSkillId,
      baseRevisionId: _baseRevisionId,
      currentRevisionId: _currentRevisionId,
      updateState: _updateState,
      customized: _customized,
      ...definition
    } = visible;
    const [forked] = await tx.insert(skills).values({
      ...definition,
      id: sql`gen_random_uuid()`,
      customized: false,
      templateSkillId: visible.id,
      baseRevisionId: visible.currentRevisionId ?? null,
      currentRevisionId: visible.currentRevisionId ?? null,
      updateState: visible.currentRevisionId ? "following" : "pinned_legacy",
      scope: "user",
      ownerUserId: owner.userId,
      accountId: owner.accountId,
      vaultId: owner.vaultId,
      successCount: 0,
      failureCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();
    const inheritedRefs = await tx.select().from(skillReferences).where(eq(skillReferences.skillId, visible.id));
    if (inheritedRefs.length > 0) {
      await tx.insert(skillReferences).values(inheritedRefs.map((reference) => ({
        skillId: forked.id,
        name: reference.name,
        content: reference.content,
      })));
    }
    await tx.update(skillPersonaPreferences)
      .set({ skillId: forked.id, updatedAt: new Date() })
      .where(and(
        eq(skillPersonaPreferences.skillId, visible.id),
        eq(skillPersonaPreferences.ownerUserId, owner.userId),
        eq(skillPersonaPreferences.accountId, owner.accountId),
      ));
    return forked;
  }

  /** Build the canonical lattice payload (identity/protocol/run-shape/refs) for a skill row. */
  private async buildSkillPayloadTx(
    tx: DbTransaction,
    row: typeof skills.$inferSelect,
  ): Promise<SkillRevisionPayload> {
    const refs = await tx.select().from(skillReferences).where(eq(skillReferences.skillId, row.id));
    return skillRevisionPayload(row, refs.map((r) => ({ name: r.name, content: r.content })));
  }

  /** Read a stored revision's immutable payload, or null. Restores never invent a prior state. */
  private async readSkillRevisionPayloadTx(
    tx: DbTransaction,
    revisionId: string | null | undefined,
  ): Promise<SkillRevisionPayload | null> {
    if (!revisionId) return null;
    const [rev] = await tx.select().from(skillRevisions).where(eq(skillRevisions.id, revisionId)).limit(1);
    return rev ? (rev.payload as SkillRevisionPayload) : null;
  }

  /** Insert an immutable skill revision and return its id. */
  private async insertSkillRevisionTx(
    tx: DbTransaction,
    row: typeof skills.$inferSelect,
    payload: SkillRevisionPayload,
    opts: {
      scope: "platform" | "user";
      parentRevisionId?: string | null;
      platformBaseRevisionId?: string | null;
      changeSummary: string;
      createdByUserId?: string | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx.insert(skillRevisions).values({
      id,
      skillIdentityId: row.id,
      scope: opts.scope,
      ownerUserId: opts.scope === "user" ? row.ownerUserId : null,
      accountId: opts.scope === "user" ? row.accountId : null,
      parentRevisionId: opts.parentRevisionId ?? null,
      platformBaseRevisionId: opts.platformBaseRevisionId ?? null,
      payload,
      contentHash: skillPayloadHash(payload),
      changeSummary: opts.changeSummary,
      createdByUserId: opts.createdByUserId ?? null,
    });
    return id;
  }

  /**
   * Whole-field replace a skill row's payload from a revision payload, then set
   * lineage/state. Whole-field only — never an AI merge of process text. Also
   * replaces the row's references so the shadow matches the payload exactly.
   */
  private async applySkillPayloadTx(
    tx: DbTransaction,
    targetId: string,
    payload: SkillRevisionPayload,
    lineage: { baseRevisionId: string; currentRevisionId: string; updateState: string },
  ): Promise<void> {
    await tx.update(skills).set({
      name: payload.name,
      description: payload.description,
      category: payload.category,
      whenToUse: payload.whenToUse,
      process: payload.process,
      outputSpec: payload.outputSpec,
      checklist: (payload.checklist ?? []) as never,
      scoreThreshold: payload.scoreThreshold,
      sessionType: payload.sessionType,
      activity: payload.activity,
      recommendedPersonaTemplateId: payload.recommendedPersonaTemplateId,
      addToMemory: payload.addToMemory,
      pinnedToContext: payload.pinnedToContext,
      baseRevisionId: lineage.baseRevisionId,
      currentRevisionId: lineage.currentRevisionId,
      updateState: lineage.updateState,
      customized: lineage.updateState !== "following",
      updatedAt: new Date(),
    }).where(eq(skills.id, targetId));
    await tx.delete(skillReferences).where(eq(skillReferences.skillId, targetId));
    if (payload.references.length > 0) {
      await tx.insert(skillReferences).values(
        payload.references.map((r) => ({ skillId: targetId, name: r.name, content: r.content })),
      );
    }
  }

  /**
   * Materialize (or resolve) the caller's user-scope copy of a global skill
   * without editing it — the "customize this skill" entry (Persona
   * ensureOwnedCopy mirror). Never edits the seed. Returns a user-scope row
   * unchanged; forks a following copy from a global; heals legacy orphans that
   * share the name but lost lineage.
   */
  async ensureOwnedSkillCopy(id: string): Promise<SkillWithReferences | undefined> {
    const principal = getCurrentPrincipal();
    if (!principal?.userId || !principal.accountId) {
      throw new Error("Skill customization requires an explicit user principal");
    }
    const owned = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`skill-override:${principal.accountId}:${principal.userId}`}))`);
      const [visible] = await tx.select().from(skills).where(this.skillVisible(eq(skills.id, id)));
      if (!visible) return undefined;
      if (visible.scope === "user") return visible;
      const [existing] = await tx.select().from(skills).where(and(
        eq(skills.scope, "user"),
        eq(skills.ownerUserId, principal.userId),
        eq(skills.accountId, principal.accountId),
        eq(skills.name, visible.name),
      ));
      if (existing) {
        if (!existing.templateSkillId) {
          const [healed] = await tx.update(skills)
            .set({ templateSkillId: visible.id, updatedAt: new Date() })
            .where(eq(skills.id, existing.id))
            .returning();
          return healed ?? existing;
        }
        return existing;
      }
      return this.forkFollowingSkillCopyTx(tx, visible, {
        userId: principal.userId,
        accountId: principal.accountId,
        vaultId: principal.activeVaultId,
      });
    });
    if (!owned) return undefined;
    return this.enrichSkillWithReferences(owned);
  }

  /**
   * Revert a user skill copy to the current platform default while keeping the
   * row (Reset → Revert). Boot never deletes a user skill: the prior user
   * revisions remain in skill_revisions for recovery; the row now follows the
   * platform revision. Retires the old delete-based reset path.
   */
  async revertSkillOverride(id: string): Promise<SkillWithReferences | undefined> {
    const principal = getCurrentPrincipal();
    if (!principal?.userId || !principal.accountId) {
      throw new Error("Skill revert requires an explicit user principal");
    }
    const reverted = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`skill-override:${principal.accountId}:${principal.userId}`}))`);
      const [visible] = await tx.select().from(skills).where(this.skillVisible(eq(skills.id, id)));
      if (!visible) return undefined;
      const [shadow] = await tx.select().from(skills).where(and(
        eq(skills.scope, "user"),
        eq(skills.ownerUserId, principal.userId),
        eq(skills.accountId, principal.accountId),
        eq(skills.name, visible.name),
      ));
      if (!shadow) return visible.scope === "global" ? visible : undefined;
      const [template] = await tx.select().from(skills).where(and(
        eq(skills.scope, "global"),
        eq(skills.name, visible.name),
      )).limit(1);
      if (!template?.currentRevisionId) return undefined;
      const platformPayload = await this.readSkillRevisionPayloadTx(tx, template.currentRevisionId);
      if (!platformPayload) return undefined;
      await this.applySkillPayloadTx(tx, shadow.id, platformPayload, {
        baseRevisionId: template.currentRevisionId,
        currentRevisionId: template.currentRevisionId,
        updateState: "following",
      });
      log.info("Skill override reverted to platform default (row preserved)", {
        skillId: shadow.id,
        platformRevisionId: template.currentRevisionId,
      });
      const [updated] = await tx.select().from(skills).where(eq(skills.id, shadow.id)).limit(1);
      return updated ?? shadow;
    });
    if (!reverted) return undefined;
    return this.enrichSkillWithReferences(reverted);
  }

  /** Accept the inbound platform default onto a customized copy (Use updated default). */
  async useUpdatedSkillDefault(id: string): Promise<SkillWithReferences | undefined> {
    const principal = getCurrentPrincipal();
    if (!principal?.userId || !principal.accountId) {
      throw new Error("Skill update acceptance requires an explicit user principal");
    }
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`skill-override:${principal.accountId}:${principal.userId}`}))`);
      const [shadow] = await tx.select().from(skills).where(this.skillWritable(eq(skills.id, id)));
      if (!shadow?.templateSkillId) return undefined;
      const [template] = await tx.select().from(skills).where(eq(skills.id, shadow.templateSkillId)).limit(1);
      if (!template?.currentRevisionId) return undefined;
      const platformPayload = await this.readSkillRevisionPayloadTx(tx, template.currentRevisionId);
      if (!platformPayload) return undefined;
      await this.applySkillPayloadTx(tx, shadow.id, platformPayload, {
        baseRevisionId: template.currentRevisionId,
        currentRevisionId: template.currentRevisionId,
        updateState: "following",
      });
      log.info("Skill accepted updated default", {
        skillId: shadow.id,
        platformRevisionId: template.currentRevisionId,
      });
      const [row] = await tx.select().from(skills).where(eq(skills.id, shadow.id)).limit(1);
      return row ?? shadow;
    });
    if (!updated) return undefined;
    return this.enrichSkillWithReferences(updated);
  }

  /** Keep mine — acknowledge an inbound default and stay customized. */
  async acknowledgeSkillUpdate(id: string): Promise<SkillWithReferences | undefined> {
    const principal = getCurrentPrincipal();
    if (!principal?.userId || !principal.accountId) {
      throw new Error("Skill acknowledgement requires an explicit user principal");
    }
    const [updated] = await db.update(skills)
      .set({ updateState: "customized", customized: true, updatedAt: new Date() })
      .where(this.skillWritable(eq(skills.id, id)))
      .returning();
    if (!updated) return undefined;
    return this.enrichSkillWithReferences(updated);
  }

  /** Preview publishing a global skill default: change summary + follower impact. */
  async previewPlatformSkillPublication(
    id: string,
    input: Partial<SkillRevisionPayload>,
  ): Promise<{
    template: SkillWithReferences;
    payload: SkillRevisionPayload;
    changedFields: string[];
    impact: { advancing: number; updateAvailable: number };
  } | null> {
    const principal = requireCurrentPrincipal();
    if (!principalHasPermission(principal, "system:write")) {
      throw new Error("system:write permission required");
    }
    return db.transaction(async (tx) => {
      const [template] = await tx.select().from(skills).where(and(
        eq(skills.id, id),
        eq(skills.scope, "global"),
      )).limit(1);
      if (!template) return null;
      const current = await this.buildSkillPayloadTx(tx, template);
      const payload = mergeSkillPayloadInput(current, input);
      const rows = await tx.select({ updateState: skills.updateState }).from(skills).where(eq(skills.templateSkillId, id));
      return {
        template: await this.enrichSkillWithReferences(template),
        payload,
        changedFields: changedSkillFields(current, payload),
        impact: {
          advancing: rows.filter((r) => r.updateState === "following").length,
          updateAvailable: rows.filter((r) => r.updateState !== "following").length,
        },
      };
    });
  }

  /**
   * Publish a global skill default (system:write). Mints an immutable platform
   * revision, advances the seed and following copies, and marks non-followers
   * update_available. Requires explicit confirmation + a change summary.
   */
  async publishPlatformSkillRevision(
    id: string,
    input: Partial<SkillRevisionPayload>,
    changeSummary: string,
    confirmed: boolean,
  ): Promise<SkillWithReferences | undefined> {
    if (!confirmed || !changeSummary.trim()) {
      throw new Error("Publication confirmation and change summary are required");
    }
    const principal = requireCurrentPrincipal();
    if (!principalHasPermission(principal, "system:write")) {
      throw new Error("system:write permission required");
    }
    const published = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7102, hashtext(${id}))`);
      const [current] = await tx.select().from(skills).where(and(
        eq(skills.id, id),
        eq(skills.scope, "global"),
      )).limit(1);
      if (!current) return undefined;
      const currentPayload = await this.buildSkillPayloadTx(tx, current);
      const payload = mergeSkillPayloadInput(currentPayload, input);
      const revisionId = await this.insertSkillRevisionTx(tx, current, payload, {
        scope: "platform",
        parentRevisionId: current.currentRevisionId ?? null,
        platformBaseRevisionId: current.currentRevisionId ?? null,
        changeSummary: changeSummary.trim(),
        createdByUserId: principal.userId ?? null,
      });
      await this.applySkillPayloadTx(tx, current.id, payload, {
        baseRevisionId: revisionId,
        currentRevisionId: revisionId,
        updateState: "following",
      });
      const followers = await tx.select().from(skills).where(and(
        eq(skills.templateSkillId, id),
        eq(skills.updateState, "following"),
      ));
      for (const follower of followers) {
        await this.applySkillPayloadTx(tx, follower.id, payload, {
          baseRevisionId: revisionId,
          currentRevisionId: revisionId,
          updateState: "following",
        });
      }
      await tx.update(skills)
        .set({ updateState: "update_available", updatedAt: new Date() })
        .where(and(
          eq(skills.templateSkillId, id),
          sql`${skills.updateState} <> 'following'`,
        ));
      log.info("Platform Skill revision published", {
        skillId: id,
        revisionId,
        advanced: followers.length,
        actorUserId: principal.userId,
        changeSummary: changeSummary.trim(),
      });
      const [row] = await tx.select().from(skills).where(eq(skills.id, id)).limit(1);
      return row ?? current;
    });
    if (!published) return undefined;
    return this.enrichSkillWithReferences(published);
  }

  /**
   * Rebase exact-hash leftover followers onto the current platform revision.
   * Exact-hash only: a copy is healed only when its current payload hash equals
   * a KNOWN platform revision of its template (which is named in the log) and it
   * carries no authored user revision beyond the lattice snapshot. Mixed or
   * unprovable rows — including autonomy 1.5-class content whose hash matches no
   * platform revision — are never overwritten; they abstain.
   */
  async healLeftoverSkillFollowers(): Promise<{ healed: number; abstained: number }> {
    let healed = 0;
    let abstained = 0;
    await db.transaction(async (tx) => {
      const copies = await tx.select().from(skills).where(and(
        eq(skills.scope, "user"),
        isNotNull(skills.templateSkillId),
        ne(skills.updateState, "customized"),
      ));
      for (const copy of copies) {
        if (!copy.templateSkillId) { abstained++; continue; }
        // Authored user work beyond the single lattice snapshot → never overwrite.
        const userRevs = await tx.select({ id: skillRevisions.id }).from(skillRevisions).where(and(
          eq(skillRevisions.skillIdentityId, copy.id),
          eq(skillRevisions.scope, "user"),
        ));
        if (userRevs.length > 1) { abstained++; continue; }
        const [template] = await tx.select().from(skills).where(eq(skills.id, copy.templateSkillId)).limit(1);
        if (!template?.currentRevisionId) { abstained++; continue; }
        const [platform] = await tx.select().from(skillRevisions).where(eq(skillRevisions.id, template.currentRevisionId)).limit(1);
        if (!platform) { abstained++; continue; }
        const copyHash = skillPayloadHash(await this.buildSkillPayloadTx(tx, copy));
        // Exact-hash only: name the platform revision this leftover reproduces.
        const [matched] = await tx.select({ id: skillRevisions.id }).from(skillRevisions).where(and(
          eq(skillRevisions.skillIdentityId, template.id),
          eq(skillRevisions.scope, "platform"),
          eq(skillRevisions.contentHash, copyHash),
        )).limit(1);
        if (!matched) { abstained++; continue; }
        const alreadyCurrent =
          copy.updateState === "following" &&
          copy.currentRevisionId === platform.id &&
          copyHash === platform.contentHash;
        if (alreadyCurrent) continue;
        await this.applySkillPayloadTx(tx, copy.id, platform.payload as SkillRevisionPayload, {
          baseRevisionId: platform.id,
          currentRevisionId: platform.id,
          updateState: "following",
        });
        log.info("healLeftoverSkillFollowers rebased leftover", {
          skillId: copy.id,
          replacedRevisionId: matched.id,
          ontoRevisionId: platform.id,
        });
        healed++;
      }
    });
    if (healed > 0 || abstained > 0) {
      log.info("healLeftoverSkillFollowers complete", { healed, abstained });
    }
    return { healed, abstained };
  }

  /**
   * Skill Default Lattice cut 3 — the code catalog is the platform seed identity
   * (SEED_PERSONAS mirror). A higher code default version mints an immutable
   * platform revision and publishes it through the same follower rules that
   * publishPlatformSkillRevision uses. This is the whole global-advancement
   * surface; boot no longer patches fingerprinted clauses or abstains silently
   * on a customized row.
   *
   * Per def, on the resolved global seat:
   * - No content drift, or the newest platform revision already carries the code
   *   payload → skip (idempotent).
   * - Live payload newer than the code default → downgrade-guarded, never write.
   * - `following` global → mint a platform revision, advance the seed and its
   *   `following` copies, mark non-following copies update_available.
   * - Mixed/customized global → record the inbound default as an available
   *   platform revision and mark it update_available. The authored payload is
   *   preserved (never overwritten); the freeze becomes a classified offer.
   *
   * System boot path: intentionally not gated on an interactive principal —
   * this is the code-owned catalog publisher, the analogue of seeding globals.
   * Human "Apply to Default" onto a customized seat remains publishPlatformSkillRevision.
   */
  async syncSkillCatalogToLattice(): Promise<{
    published: number;
    advancedFollowers: number;
    offered: number;
    skipped: number;
    downgradeGuarded: number;
  }> {
    let published = 0;
    let advancedFollowers = 0;
    let offered = 0;
    let skipped = 0;
    let downgradeGuarded = 0;

    for (const { name, version: codeVersion, input } of codeCatalogSkillInputs()) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(7102, hashtext(${name}))`);
        const [global] = await tx.select().from(skills).where(and(
          eq(skills.scope, "global"),
          eq(skills.name, name),
        )).limit(1);
        // Only lattice seats seeded from the code catalog participate here; a
        // Mod-managed or not-yet-snapshotted row is left to its owner.
        if (!global || !global.currentRevisionId) { skipped++; return; }

        const currentPayload = await this.buildSkillPayloadTx(tx, global);
        const codePayload = mergeSkillPayloadInput(currentPayload, input);
        const codeHash = skillPayloadHash(codePayload);
        const currentHash = skillPayloadHash(currentPayload);

        const [latestPlatform] = await tx.select().from(skillRevisions).where(and(
          eq(skillRevisions.skillIdentityId, global.id),
          eq(skillRevisions.scope, "platform"),
        )).orderBy(desc(skillRevisions.createdAt)).limit(1);

        // Idempotent: the code payload is already the newest recorded default.
        if (latestPlatform?.contentHash === codeHash) { skipped++; return; }
        if (codeHash === currentHash) { skipped++; return; }

        // Never downgrade a live payload that is newer than the code default.
        const order = compareSkillVersions(global.version, codeVersion);
        if (order !== null && order > 0) { downgradeGuarded++; return; }

        if (global.updateState === "following") {
          const revisionId = await this.insertSkillRevisionTx(tx, global, codePayload, {
            scope: "platform",
            parentRevisionId: global.currentRevisionId ?? null,
            platformBaseRevisionId: global.currentRevisionId ?? null,
            changeSummary: `Code catalog ${codeVersion}`,
            createdByUserId: null,
          });
          await this.applySkillPayloadTx(tx, global.id, codePayload, {
            baseRevisionId: revisionId,
            currentRevisionId: revisionId,
            updateState: "following",
          });
          await tx.update(skills).set({ version: codeVersion, updatedAt: new Date() }).where(eq(skills.id, global.id));
          const followers = await tx.select().from(skills).where(and(
            eq(skills.templateSkillId, global.id),
            eq(skills.updateState, "following"),
          ));
          for (const follower of followers) {
            await this.applySkillPayloadTx(tx, follower.id, codePayload, {
              baseRevisionId: revisionId,
              currentRevisionId: revisionId,
              updateState: "following",
            });
            await tx.update(skills).set({ version: codeVersion, updatedAt: new Date() }).where(eq(skills.id, follower.id));
            advancedFollowers++;
          }
          await tx.update(skills)
            .set({ updateState: "update_available", updatedAt: new Date() })
            .where(and(
              eq(skills.templateSkillId, global.id),
              sql`${skills.updateState} <> 'following'`,
            ));
          published++;
          log.info("Skill catalog published platform revision", {
            name, skillId: global.id, codeVersion, revisionId, advancedFollowers: followers.length,
          });
        } else {
          // Mixed/customized global — offer the inbound default, never overwrite
          // authored clauses. Its currentRevisionId/payload are untouched; the
          // freeze is now a classified offer a human can Apply to Default.
          await this.insertSkillRevisionTx(tx, global, codePayload, {
            scope: "platform",
            parentRevisionId: global.currentRevisionId ?? null,
            platformBaseRevisionId: global.baseRevisionId ?? null,
            changeSummary: `Code catalog ${codeVersion} (offered inbound)`,
            createdByUserId: null,
          });
          await tx.update(skills)
            .set({ updateState: "update_available", updatedAt: new Date() })
            .where(eq(skills.id, global.id));
          offered++;
          log.info("Skill catalog offered inbound default to customized global", {
            name, skillId: global.id, codeVersion, liveVersion: global.version,
          });
        }
      });
    }

    log.info("Skill catalog lattice sync complete", {
      published, advancedFollowers, offered, skipped, downgradeGuarded,
    });
    return { published, advancedFollowers, offered, skipped, downgradeGuarded };
  }

  async deleteSkill(id: string): Promise<boolean> {
    const principal = getCurrentPrincipal();
    if (!principal?.userId || !principal.accountId) {
      throw new Error("Skill deletion requires an explicit user principal");
    }
    const [visible] = await db.select().from(skills).where(this.skillVisible(eq(skills.id, id)));
    if (!visible) return false;
    if (visible.scope === "global") return false;
    const [deleted] = await db.delete(skills).where(this.skillWritable(eq(skills.id, id))).returning();
    return !!deleted;
  }

  async incrementSkillSuccess(id: string): Promise<void> {
    await db.update(skills)
      .set({ successCount: sql`${skills.successCount} + 1`, updatedAt: new Date() })
      .where(this.skillWritable(eq(skills.id, id)));
  }

  async incrementSkillFailure(id: string): Promise<void> {
    await db.update(skills)
      .set({ failureCount: sql`${skills.failureCount} + 1`, updatedAt: new Date() })
      .where(this.skillWritable(eq(skills.id, id)));
  }

  // insertSkillScore, getLatestSkillScore, getSkillScores, getSkillLastRuns removed — skill_scores superseded by skill_runs

  async getSkillFailedNames(): Promise<{ name: string; scoredAt: string }[]> {
    const allSkills = await db.select({ name: skills.name }).from(skills).where(this.skillVisible());
    const validSkillNames = new Set(allSkills.map(s => s.name));

    const principal = requireCurrentPrincipal();
    if (principal.actorType !== "system" && (!principal.userId || !principal.accountId)) return [];
    const runOwnerClause = principal.actorType === "system"
      ? sql`TRUE`
      : sql`r.owner_user_id = ${principal.userId} AND r.account_id = ${principal.accountId}`;
    const dismissalOwnerClause = principal.actorType === "system"
      ? sql`TRUE`
      : sql`d.owner_user_id = ${principal.userId} AND d.account_id = ${principal.accountId}`;
    const failedFromRuns = await db.execute(sql`
      SELECT f.skill_name, f.scored_at
      FROM (
        SELECT DISTINCT ON (r.skill_name) r.skill_name, COALESCE(r.completed_at, r.started_at) AS scored_at
        FROM skill_runs r
        WHERE ${runOwnerClause} AND (r.status = 'failed' OR (r.pass_rate IS NOT NULL AND r.pass_rate <= 0.5))
        ORDER BY r.skill_name, COALESCE(r.completed_at, r.started_at) DESC
      ) f
      LEFT JOIN skill_failure_dismissals d
        ON f.skill_name = d.skill_name AND ${dismissalOwnerClause}
      WHERE d.dismissed_at IS NULL OR d.dismissed_at < f.scored_at
    `);

    const latestRunPerSkill = await db.execute(sql`
      SELECT DISTINCT ON (r.skill_name) r.skill_name, r.status, r.pass_rate
      FROM skill_runs r
      WHERE ${runOwnerClause}
      ORDER BY r.skill_name, COALESCE(r.completed_at, r.started_at) DESC
    `);
    const latestRunMap = new Map<string, { status: string; pass_rate: number | null }>();
    for (const r of latestRunPerSkill.rows as Array<{ skill_name: string; status: string; pass_rate: number | null }>) {
      latestRunMap.set(r.skill_name, { status: r.status, pass_rate: r.pass_rate });
    }

    const merged = new Map<string, string>();
    for (const r of failedFromRuns.rows as Array<{ skill_name: string; scored_at: Date }>) {
      if (!validSkillNames.has(r.skill_name)) continue;
      const latest = latestRunMap.get(r.skill_name);
      if (latest) {
        // If the latest run is still in progress, don't report this skill as failed
        if (latest.status === 'running' || latest.status === 'yielded' || latest.status === 'checkpoint') continue;
        const isLatestSuccessful = latest.status !== 'failed'
          && (latest.pass_rate === null || latest.pass_rate > 0.5);
        if (isLatestSuccessful) continue;
      }
      merged.set(r.skill_name, new Date(r.scored_at).toISOString());
    }

    const result: { name: string; scoredAt: string }[] = [];
    for (const [name, scoredAt] of merged) {
      result.push({ name, scoredAt });
    }
    return result;
  }

  async dismissSkillFailure(skillName: string): Promise<void> {
    const principal = getCurrentPrincipal();
    if (!principal?.userId || !principal.accountId) {
      throw new Error("Skill failure dismissal requires an explicit user principal");
    }
    const visibleSkill = await this.getSkillByName(skillName);
    if (!visibleSkill) throw new Error(`Skill "${skillName}" not found`);
    await db
      .insert(skillFailureDismissals)
      .values({
        skillName: visibleSkill.name,
        ownerUserId: principal.userId,
        accountId: principal.accountId,
        dismissedAt: sql`CURRENT_TIMESTAMP`,
      })
      .onConflictDoUpdate({
        target: [
          skillFailureDismissals.ownerUserId,
          skillFailureDismissals.accountId,
          skillFailureDismissals.skillName,
        ],
        set: { dismissedAt: sql`CURRENT_TIMESTAMP` },
      });
  }


  async insertSkillRun(data: {
    skillName: string;
    sessionId: string;
    status?: SkillRunStatus;
    parentSessionId?: string;
    parentSkillRunId?: number;
    parentToolCallId?: string;
    runtimeRunId?: string;
  }): Promise<SkillRun> {
    const [inserted] = await db.insert(skillRuns).values({
      skillName: data.skillName,
      sessionId: data.sessionId,
      status: data.status || "running",
      parentSessionId: data.parentSessionId ?? null,
      parentSkillRunId: data.parentSkillRunId ?? null,
      parentToolCallId: data.parentToolCallId ?? null,
      runtimeRunId: data.runtimeRunId ?? null,
      ...ownedInsertValues(requireCurrentPrincipal(), skillRunScopeColumns),
    }).onConflictDoNothing({ target: skillRuns.sessionId }).returning();
    if (inserted) return inserted;
    const [existing] = await db.select().from(skillRuns)
      .where(this.runWritable(eq(skillRuns.sessionId, data.sessionId)));
    if (
      existing
      && existing.skillName === data.skillName
      && existing.parentSessionId === (data.parentSessionId ?? null)
      && existing.parentSkillRunId === (data.parentSkillRunId ?? null)
      && existing.parentToolCallId === (data.parentToolCallId ?? null)
      && existing.runtimeRunId === (data.runtimeRunId ?? null)
    ) {
      return existing;
    }
    throw new Error(`SkillRun replay identity conflict for session ${data.sessionId}`);
  }

  async updateSkillRunStatus(sessionId: string, status: SkillRunStatus, durationMs?: number, failureReason?: string): Promise<SkillRun | null> {
    const updates: Record<string, unknown> = { status, completedAt: new Date() };
    if (durationMs !== undefined) updates.durationMs = durationMs;
    if (failureReason !== undefined) updates.failureReason = failureReason;
    const [row] = await db.update(skillRuns)
      .set(updates)
      .where(this.runWritable(eq(skillRuns.sessionId, sessionId)))
      .returning();
    return row ?? null;
  }

  // Guarded post-completion transition (e.g. succeeded → degraded after async
  // scoring). Preserves completedAt/durationMs; the fromStatus guard in the
  // WHERE makes the transition atomic, so races and double-downgrades are
  // structurally unrepresentable.
  async reconcileSkillRunStatus(sessionId: string, fromStatus: SkillRunStatus, toStatus: SkillRunStatus, failureReason: string): Promise<SkillRun | null> {
    const [row] = await db.update(skillRuns)
      .set({ status: toStatus, failureReason })
      .where(this.runWritable(and(eq(skillRuns.sessionId, sessionId), eq(skillRuns.status, fromStatus))))
      .returning();
    return row ?? null;
  }

  async updateSkillRunScore(sessionId: string, data: {
    passRate: number;
    checklistTotal: number;
    checklistPassed: number;
    checklistResults: CheckResult[];
    comparativeVsId?: number | null;
    comparativeWinner?: "current" | "prior" | "tie" | null;
    comparativeReason?: string | null;
  }): Promise<SkillRun | null> {
    const [row] = await db.update(skillRuns)
      .set({
        passRate: data.passRate,
        checklistTotal: data.checklistTotal,
        checklistPassed: data.checklistPassed,
        checklistResults: data.checklistResults,
        comparativeVsId: data.comparativeVsId ?? null,
        comparativeWinner: data.comparativeWinner ?? null,
        comparativeReason: data.comparativeReason ?? null,
      })
      .where(this.runWritable(eq(skillRuns.sessionId, sessionId)))
      .returning();
    return row ?? null;
  }

  async getSkillRunBySessionId(sessionId: string): Promise<SkillRun | null> {
    const [row] = await db.select().from(skillRuns).where(this.runVisible(eq(skillRuns.sessionId, sessionId)));
    return row ?? null;
  }

  async getSkillRunByRuntimeRunId(runtimeRunId: string): Promise<SkillRun | null> {
    const [row] = await db.select().from(skillRuns).where(this.runVisible(eq(skillRuns.runtimeRunId, runtimeRunId)));
    return row ?? null;
  }

  async getChildSkillRunsByParent(parentSkillRunId: number): Promise<SkillRun[]> {
    return db.select().from(skillRuns)
      .where(this.runVisible(eq(skillRuns.parentSkillRunId, parentSkillRunId)))
      .orderBy(desc(skillRuns.startedAt))
      .limit(50);
  }

  async getSkillRuns(skillName: string, limit = 20): Promise<SkillRun[]> {
    const bounded = Math.min(Math.max(1, limit), 50);
    return db.select().from(skillRuns)
      .where(this.runVisible(eq(skillRuns.skillName, skillName)))
      .orderBy(desc(skillRuns.startedAt))
      .limit(bounded);
  }

  async getSkillRunLastRuns(): Promise<Record<string, string>> {
    const rows = await db
      .selectDistinctOn([skillRuns.skillName], {
        skillName: skillRuns.skillName,
        startedAt: skillRuns.startedAt,
      })
      .from(skillRuns)
      .where(this.runVisible())
      .orderBy(skillRuns.skillName, desc(skillRuns.startedAt));
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.skillName] = row.startedAt.toISOString();
    }
    return result;
  }

  async getLatestScoredSkillRun(skillName: string): Promise<SkillRun | null> {
    const [row] = await db.select().from(skillRuns)
      .where(this.runVisible(sql`${skillRuns.skillName} = ${skillName} AND ${skillRuns.passRate} IS NOT NULL`))
      .orderBy(desc(skillRuns.startedAt))
      .limit(1);
    return row ?? null;
  }

  async healStuckSkillRuns(): Promise<number> {
    const stuck = await db.update(skillRuns)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(skillRuns.status, "running"))
      .returning();
    return stuck.length;
  }

  async dismissLogErrors(): Promise<void> {
    const now = new Date();
    const iso = now.toISOString();
    // Defense in depth: pass updatedAt explicitly so we don't depend on the
    // table-level CURRENT_TIMESTAMP default existing on every deployed DB
    // (Railway-provisioned envs were observed missing the default — only the
    // NOT NULL — and would reject the insert side of the upsert otherwise).
    await db
      .insert(systemSettings)
      .values({ key: "log_error_dismissed_at", value: iso, updatedAt: now })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: iso, updatedAt: now },
      });
  }

  async getLogErrorDismissedAt(): Promise<string | null> {
    const [row] = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, "log_error_dismissed_at"));
    if (!row) return null;
    return row.value as string;
  }

  async claimVoiceSessionActive(input: {
    sessionId: string;
    chatSessionId: string;
    requestId: string;
    bootId: string;
    principal: Principal;
    reconnect: boolean;
  }): Promise<VoiceLeaseClaimResult> {
    const { principal } = input;
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Voice lease claim requires an authenticated user principal");
    }
    if (!input.chatSessionId || !input.requestId) {
      throw new Error("Voice lease claim requires chatSessionId and requestId");
    }

    return db.transaction(async (tx) => {
      const lockKey = fnv1a32(`${principal.accountId}:${input.chatSessionId}`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${0x56535452}::int4, ${lockKey}::int4)`);

      const [replayed] = await tx.select()
        .from(voiceSessionActive)
        .where(and(
          eq(voiceSessionActive.accountId, principal.accountId),
          eq(voiceSessionActive.startRequestId, input.requestId),
          eq(voiceSessionActive.scope, "user"),
        ))
        .limit(1);
      if (replayed) {
        if (replayed.chatSessionId !== input.chatSessionId) {
          throw new Error("Voice start requestId is already bound to another conversation");
        }
        return { outcome: "existing", lease: replayed };
      }

      const [active] = await tx.select()
        .from(voiceSessionActive)
        .where(and(
          eq(voiceSessionActive.accountId, principal.accountId),
          eq(voiceSessionActive.chatSessionId, input.chatSessionId),
          eq(voiceSessionActive.status, "active"),
          eq(voiceSessionActive.scope, "user"),
        ))
        .limit(1);

      if (active && !input.reconnect) {
        return { outcome: "conflict", lease: active };
      }

      if (active) {
        await tx.update(voiceSessionActive)
          .set({ status: "abandoned", endedAt: new Date(), inflightTurn: 0 })
          .where(and(
            eq(voiceSessionActive.id, active.id),
            eq(voiceSessionActive.accountId, principal.accountId),
            eq(voiceSessionActive.status, "active"),
          ));
      }

      const [lease] = await tx.insert(voiceSessionActive).values({
        sessionId: input.sessionId,
        chatSessionId: input.chatSessionId,
        status: "active",
        bootId: input.bootId,
        scope: "user",
        ownerUserId: principal.userId,
        accountId: principal.accountId,
        startRequestId: input.requestId,
      }).returning();

      return { outcome: "claimed", lease, replacedSessionId: active?.sessionId ?? null };
    });
  }


  async claimProvisionalVoiceSessionActive(input: {
    sessionId: string;
    capabilityKey: string;
    requestId: string;
    bootId: string;
  }): Promise<VoiceLeaseClaimResult> {
    if (!input.capabilityKey || !input.requestId) {
      throw new Error("Provisional voice lease requires capabilityKey and requestId");
    }

    return db.transaction(async (tx) => {
      const lockKey = fnv1a32(input.capabilityKey);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${0x56535452}::int4, ${lockKey}::int4)`);

      const [replayed] = await tx.select()
        .from(voiceSessionActive)
        .where(and(
          eq(voiceSessionActive.chatSessionId, input.capabilityKey),
          eq(voiceSessionActive.startRequestId, input.requestId),
          eq(voiceSessionActive.scope, "system"),
        ))
        .limit(1);
      if (replayed) return { outcome: "existing", lease: replayed };

      const [active] = await tx.select()
        .from(voiceSessionActive)
        .where(and(
          eq(voiceSessionActive.chatSessionId, input.capabilityKey),
          eq(voiceSessionActive.status, "active"),
          eq(voiceSessionActive.scope, "system"),
        ))
        .limit(1);
      if (active) {
        await tx.update(voiceSessionActive)
          .set({ status: "abandoned", endedAt: new Date(), inflightTurn: 0 })
          .where(and(
            eq(voiceSessionActive.id, active.id),
            eq(voiceSessionActive.status, "active"),
            eq(voiceSessionActive.scope, "system"),
          ));
      }

      const [lease] = await tx.insert(voiceSessionActive).values({
        sessionId: input.sessionId,
        chatSessionId: input.capabilityKey,
        status: "active",
        bootId: input.bootId,
        scope: "system",
        ownerUserId: null,
        accountId: null,
        startRequestId: input.requestId,
      }).returning();

      return { outcome: "claimed", lease, replacedSessionId: active?.sessionId ?? null };
    });
  }

  async getProvisionalVoiceSessionStartByRequest(
    requestId: string,
    capabilityKey: string,
  ): Promise<VoiceSessionActive | undefined> {
    const [row] = await db.select()
      .from(voiceSessionActive)
      .where(and(
        eq(voiceSessionActive.startRequestId, requestId),
        eq(voiceSessionActive.chatSessionId, capabilityKey),
        eq(voiceSessionActive.scope, "system"),
      ))
      .limit(1);
    return row;
  }

  async completeVoiceSessionStart(sessionId: string, bootId: string, response: Record<string, unknown>): Promise<VoiceSessionActive | undefined> {
    const [row] = await db.update(voiceSessionActive)
      .set({ startResponse: response, startReadyAt: new Date() })
      .where(and(
        eq(voiceSessionActive.sessionId, sessionId),
        eq(voiceSessionActive.bootId, bootId),
        eq(voiceSessionActive.status, "active"),
      ))
      .returning();
    return row;
  }

  async getVoiceSessionStartByRequest(requestId: string, principal: Principal): Promise<VoiceSessionActive | undefined> {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) return undefined;
    const [row] = await db.select()
      .from(voiceSessionActive)
      .where(and(
        eq(voiceSessionActive.startRequestId, requestId),
        eq(voiceSessionActive.ownerUserId, principal.userId),
        eq(voiceSessionActive.accountId, principal.accountId),
        eq(voiceSessionActive.scope, "user"),
      ))
      .limit(1);
    return row;
  }

  async getOwnedActiveVoiceSession(sessionId: string, bootId: string): Promise<VoiceSessionActive | undefined> {
    const [row] = await db.select()
      .from(voiceSessionActive)
      .where(and(
        eq(voiceSessionActive.sessionId, sessionId),
        eq(voiceSessionActive.status, "active"),
        eq(voiceSessionActive.bootId, bootId),
        inArray(voiceSessionActive.scope, ["user", "system"]),
      ))
      .limit(1);
    return row;
  }

  async endVoiceSessionActive(sessionId: string, status: "complete" | "abandoned", authority: VoiceLeaseMutationAuthority): Promise<void> {
    await db.update(voiceSessionActive)
      .set({ status, endedAt: new Date(), inflightTurn: 0 })
      .where(voiceLeaseWritablePredicate(sessionId, authority));
  }

  async completeOwnedVoiceSession(
    sessionId: string,
    chatSessionId: string,
    principal: Principal,
  ): Promise<"completed" | "already_complete" | "superseded" | "not_completable"> {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      return "not_completable";
    }
    return db.transaction(async (tx) => {
      const lockKey = fnv1a32(`${principal.accountId}:${chatSessionId}`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${0x56535452}::int4, ${lockKey}::int4)`);
      const [lease] = await tx.select({ status: voiceSessionActive.status })
        .from(voiceSessionActive)
        .where(and(
          eq(voiceSessionActive.sessionId, sessionId),
          eq(voiceSessionActive.chatSessionId, chatSessionId),
          eq(voiceSessionActive.scope, "user"),
          eq(voiceSessionActive.ownerUserId, principal.userId),
          eq(voiceSessionActive.accountId, principal.accountId),
        ))
        .limit(1);

      if (!lease || (lease.status !== "active" && lease.status !== "complete")) {
        return "not_completable";
      }
      if (lease.status === "complete") {
        const [newerActiveLease] = await tx.select({ sessionId: voiceSessionActive.sessionId })
          .from(voiceSessionActive)
          .where(and(
            eq(voiceSessionActive.chatSessionId, chatSessionId),
            eq(voiceSessionActive.status, "active"),
            eq(voiceSessionActive.scope, "user"),
            eq(voiceSessionActive.ownerUserId, principal.userId),
            eq(voiceSessionActive.accountId, principal.accountId),
            ne(voiceSessionActive.sessionId, sessionId),
          ))
          .limit(1);
        return newerActiveLease ? "superseded" : "already_complete";
      }

      await tx.update(voiceSessionActive)
        .set({ status: "complete", endedAt: new Date(), inflightTurn: 0 })
        .where(and(
          eq(voiceSessionActive.sessionId, sessionId),
          eq(voiceSessionActive.chatSessionId, chatSessionId),
          eq(voiceSessionActive.status, "active"),
          eq(voiceSessionActive.scope, "user"),
          eq(voiceSessionActive.ownerUserId, principal.userId),
          eq(voiceSessionActive.accountId, principal.accountId),
        ));
      return "completed";
    });
  }

  async abandonOwnedVoiceSession(
    sessionId: string,
    chatSessionId: string,
    principal: Principal,
  ): Promise<"abandoned" | "already_terminal" | "not_owned"> {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      return "not_owned";
    }
    return db.transaction(async (tx) => {
      const lockKey = fnv1a32(`${principal.accountId}:${chatSessionId}`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${0x56535452}::int4, ${lockKey}::int4)`);
      const [lease] = await tx.select({ status: voiceSessionActive.status })
        .from(voiceSessionActive)
        .where(and(
          eq(voiceSessionActive.sessionId, sessionId),
          eq(voiceSessionActive.chatSessionId, chatSessionId),
          eq(voiceSessionActive.scope, "user"),
          eq(voiceSessionActive.ownerUserId, principal.userId),
          eq(voiceSessionActive.accountId, principal.accountId),
        ))
        .limit(1);
      if (!lease) return "not_owned";
      if (lease.status !== "active") return "already_terminal";
      await tx.update(voiceSessionActive)
        .set({ status: "abandoned", endedAt: new Date(), inflightTurn: 0 })
        .where(and(
          eq(voiceSessionActive.sessionId, sessionId),
          eq(voiceSessionActive.chatSessionId, chatSessionId),
          eq(voiceSessionActive.status, "active"),
          eq(voiceSessionActive.scope, "user"),
          eq(voiceSessionActive.ownerUserId, principal.userId),
          eq(voiceSessionActive.accountId, principal.accountId),
        ));
      return "abandoned";
    });
  }

  async updateVoiceSessionInflight(sessionId: string, inflightTurn: number, bootId: string): Promise<void> {
    await db.update(voiceSessionActive)
      .set({ inflightTurn, lastHeartbeat: new Date() })
      .where(and(
        eq(voiceSessionActive.sessionId, sessionId),
        eq(voiceSessionActive.bootId, bootId),
        eq(voiceSessionActive.status, "active"),
      ));
  }

  async clearVoiceSessionInflight(sessionId: string, bootId: string): Promise<void> {
    await db.update(voiceSessionActive)
      .set({ inflightTurn: 0, lastHeartbeat: new Date() })
      .where(and(
        eq(voiceSessionActive.sessionId, sessionId),
        eq(voiceSessionActive.bootId, bootId),
        eq(voiceSessionActive.status, "active"),
      ));
  }

  async abandonExpiredVoiceSessions(staleBefore: Date): Promise<VoiceSessionActive[]> {
    // Process identity is not a liveness signal. More than one app process may
    // share this database, so a foreign boot_id can still own a healthy call.
    // Only the server-wide maximum session age is safe for boot cleanup.
    return db.update(voiceSessionActive)
      .set({ status: "abandoned", endedAt: new Date(), inflightTurn: 0 })
      .where(and(
        eq(voiceSessionActive.status, "active"),
        lte(voiceSessionActive.startedAt, staleBefore),
      ))
      .returning();
  }

  async getActiveVoiceSessions(bootId: string): Promise<VoiceSessionActive[]> {
    // boot_id is the durable owner of the process-local voice session Map. A
    // process must never reconcile another process's leases against its Map.
    return db.select()
      .from(voiceSessionActive)
      .where(and(
        eq(voiceSessionActive.status, "active"),
        eq(voiceSessionActive.bootId, bootId),
      ));
  }

  async pruneVoiceSessions(retentionDays: number): Promise<{ deleted: number; remaining: number }> {
    const days = Math.max(1, Math.floor(retentionDays));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const deletedRows = await db.delete(voiceSessionActive)
      .where(and(
        sql`${voiceSessionActive.status} <> 'active'`,
        sql`${voiceSessionActive.endedAt} IS NOT NULL`,
        lte(voiceSessionActive.endedAt, cutoff),
      ))
      .returning({ id: voiceSessionActive.id });
    const [{ cnt }] = await db.select({ cnt: count() }).from(voiceSessionActive);
    return { deleted: deletedRows.length, remaining: Number(cnt) };
  }

  async getTriagedMessageIds(sinceHours = 168): Promise<string[]> {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    const liveRows = await db.select({ providerMessageId: emailMessages.providerMessageId })
      .from(emailMessages)
      .where(combineWithSensitiveVisible(emailMessageScopeColumns, and(
        or(eq(emailMessages.triageStatus, "triaged"), eq(emailMessages.triageStatus, "dismissed")),
        gte(emailMessages.triagedAt, since),
      )))
      .limit(5000);

    const legacyRows = await db.select({ gmailMessageId: emailTriageLog.gmailMessageId })
      .from(emailTriageLog)
      .where(and(
        gte(emailTriageLog.triagedAt, since),
        sql`${emailTriageLog.accountId} IN (SELECT account_id FROM connected_accounts WHERE ${combineWithSensitiveVisible(connectedAccountScopeColumns)})`,
      ))
      .limit(5000);

    const ids = Array.from(new Set([
      ...liveRows.map(r => r.providerMessageId),
      ...legacyRows.map(r => r.gmailMessageId),
    ]));
    log.log(`getTriagedMessageIds sinceHours=${sinceHours} live=${liveRows.length} legacy=${legacyRows.length} unique=${ids.length}`);
    return ids;
  }

  async recordTriagedEmail(entry: InsertEmailTriageLog): Promise<EmailTriageLog> {
    const [created] = await db.insert(emailTriageLog)
      .values({ ...entry, ...sensitiveOwnershipValues() })
      .onConflictDoNothing()
      .returning();
    log.log(`recordTriagedEmail msgId=${entry.gmailMessageId} tier=${entry.tier}`);
    return created;
  }

  async recordTriagedEmails(entries: InsertEmailTriageLog[]): Promise<void> {
    if (entries.length === 0) return;
    await db.insert(emailTriageLog)
      .values(entries.map(entry => ({ ...entry, ...sensitiveOwnershipValues() })))
      .onConflictDoNothing();
    log.log(`recordTriagedEmails count=${entries.length}`);
  }

  async getUntriagedCachedEmails(limit = 5000): Promise<EmailMessage[]> {
    // Recency scope: only triage emails from the last 30 days.
    // isDone is an attention-layer concept, not a pipeline gate.
    // Recency replaces isDone as the scope boundary that prevents
    // reprocessing the entire historical email archive.
    const recencyCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return db.select()
      .from(emailMessages)
      .where(combineWithSensitiveVisible(emailMessageScopeColumns, and(
        eq(emailMessages.triageStatus, "untriaged"),
        sql`${emailMessages.direction} <> 'outbound'`,
        gte(emailMessages.date, recencyCutoff),
      )))
      .orderBy(desc(emailMessages.date))
      .limit(limit);
  }

  async getOpenCachedMessagesForReconcile(accountId: string, limit: number): Promise<EmailMessage[]> {
    return db.select()
      .from(emailMessages)
      .where(combineWithSensitiveVisible(emailMessageScopeColumns, and(
        eq(emailMessages.accountId, accountId),
        eq(emailMessages.isDone, false),
        ne(emailMessages.triageStatus, 'untriaged'),
      )))
      .orderBy(emailMessages.updatedAt)
      .limit(limit);
  }

  async touchOpenCachedMessages(messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;
    await db.update(emailMessages)
      .set({ updatedAt: new Date() })
      .where(combineWithSensitiveWritable(emailMessageScopeColumns, inArray(emailMessages.id, messageIds)));
  }

  async reconcileExternalArchive(messageId: number, reason: string): Promise<void> {
    const [row] = await db.select({
      id: emailMessages.id,
      accountId: emailMessages.accountId,
      providerThreadId: emailMessages.providerThreadId,
      providerMessageId: emailMessages.providerMessageId,
      triageTier: emailMessages.triageTier,
      fromAddress: emailMessages.fromAddress,
      subject: emailMessages.subject,
      isDone: emailMessages.isDone,
    }).from(emailMessages).where(combineWithSensitiveVisible(emailMessageScopeColumns, eq(emailMessages.id, messageId))).limit(1);

    if (!row || row.isDone) return;

    await db.update(emailMessages)
      .set({ isDone: true, doneReason: reason, doneAt: new Date(), updatedAt: new Date() })
      .where(combineWithSensitiveWritable(emailMessageScopeColumns, eq(emailMessages.id, messageId)));

    try {
      await db.insert(emailDismissals).values({
        messageId: row.id,
        providerThreadId: row.providerThreadId || row.providerMessageId,
        accountId: row.accountId,
        tier: row.triageTier || '',
        sender: row.fromAddress || null,
        subject: row.subject || null,
        reason,
        dismissedBy: 'external_archive',
      });
    } catch (err: any) {
      log.debug(`reconcileExternalArchive dismissal insert failed for msg=${messageId}: ${err.message}`);
    }
  }

  async updateEmailTriageState(id: number, tier: string, reason: string): Promise<EmailMessage | undefined> {
    const [updated] = await db.update(emailMessages)
      .set({
        triageStatus: "triaged",
        triageTier: tier,
        triageReason: reason,
        triagedAt: new Date(),
      })
      .where(combineWithSensitiveWritable(emailMessageScopeColumns, and(eq(emailMessages.id, id), sql`${emailMessages.ownerUserId} IS NOT NULL`, sql`${emailMessages.principalAccountId} IS NOT NULL`)))
      .returning();
    return updated;
  }

  /**
   * A thread is "engaged" when Ray has sent an outbound message on it or when
   * another message on it is already sitting in Review. Replies on engaged
   * threads must never be auto-dismissed, regardless of classifier tier —
   * a confirmation from a real correspondent is not FYI noise.
   */
  private async isThreadEngaged(messageId: number): Promise<boolean> {
    const [row] = await db.select({ accountId: emailMessages.accountId, providerThreadId: emailMessages.providerThreadId })
      .from(emailMessages)
      .where(combineWithSensitiveVisible(emailMessageScopeColumns, eq(emailMessages.id, messageId)));
    if (!row?.providerThreadId) return false;
    const [engaged] = await db.select({ id: emailMessages.id })
      .from(emailMessages)
      .where(combineWithSensitiveVisible(emailMessageScopeColumns, and(
        eq(emailMessages.accountId, row.accountId),
        eq(emailMessages.providerThreadId, row.providerThreadId),
        ne(emailMessages.id, messageId),
        or(
          eq(emailMessages.direction, "outbound"),
          and(eq(emailMessages.triageStatus, "triaged"), eq(emailMessages.isDone, false)),
        ),
      )))
      .limit(1);
    return Boolean(engaged);
  }

  async batchUpdateEmailTriageState(updates: Array<{ id: number; tier: string; reason: string }>): Promise<Array<{ accountId: string; providerMessageId: string }>> {
    const AUTO_DISMISS_TIERS = new Set(["🗑️", "📋"]);
    const dismissed: Array<{ accountId: string; providerMessageId: string }> = [];
    for (const u of updates) {
      let tier = u.tier;
      let reason = u.reason;
      let autoDismiss = AUTO_DISMISS_TIERS.has(tier);

      // Engaged-thread guard: keep replies on Ray-engaged threads in Review.
      if (autoDismiss && await this.isThreadEngaged(u.id)) {
        autoDismiss = false;
        tier = "🟢";
        reason = `${u.reason} — kept in Review: reply on a thread Ray is engaged in`;
        log.log(`triage engaged-thread guard kept message ${u.id} in Review (classifier tier was ${u.tier})`);
      }

      const [updated] = await db.update(emailMessages)
        .set({
          triageStatus: autoDismiss ? "dismissed" : "triaged",
          triageTier: tier,
          triageReason: reason,
          triagedAt: new Date(),
          ...(autoDismiss ? { isDone: true, doneReason: tier === "🗑️" ? "auto_noise" : "auto_fyi", doneAt: new Date(), updatedAt: new Date() } : {}),
        })
        .where(combineWithSensitiveWritable(emailMessageScopeColumns, and(eq(emailMessages.id, u.id), sql`${emailMessages.ownerUserId} IS NOT NULL`, sql`${emailMessages.principalAccountId} IS NOT NULL`)))
        .returning();

      if (autoDismiss && updated) {
        dismissed.push({ accountId: updated.accountId, providerMessageId: updated.providerMessageId });
        await db.insert(emailDismissals).values({
          messageId: updated.id,
          providerThreadId: updated.providerThreadId || updated.providerMessageId,
          accountId: updated.accountId,
          tier,
          sender: updated.fromAddress || null,
          subject: updated.subject || null,
          reason: `Auto-dismissed during triage: ${tier === "🗑️" ? "Noise" : "FYI"} tier — ${reason}`,
          dismissedBy: "auto",
          ...sensitiveOwnershipValues(),
        }).catch(() => {});
      }
    }
    return dismissed;
  }

  async markEmailDone(id: number, done: boolean): Promise<EmailMessage | undefined> {
    const [updated] = await db.update(emailMessages)
      .set({ isDone: done, doneReason: done ? "user_done" : null, doneAt: done ? new Date() : null, updatedAt: new Date() })
      .where(combineWithSensitiveWritable(emailMessageScopeColumns, eq(emailMessages.id, id)))
      .returning();
    return updated;
  }

  async getCachedEmailById(id: number): Promise<EmailMessage | undefined> {
    const [row] = await db.select().from(emailMessages).where(combineWithSensitiveVisible(emailMessageScopeColumns, eq(emailMessages.id, id)));
    return row;
  }

  async deleteCachedEmail(id: number): Promise<boolean> {
    return db.transaction(async (tx) => {
      const writable = combineWithSensitiveWritable(emailMessageScopeColumns, eq(emailMessages.id, id));
      const [owned] = await tx.select({ id: emailMessages.id }).from(emailMessages).where(writable).limit(1);
      if (!owned) return false;
      await tx.update(emailEnrichments).set({ messageId: null }).where(combineWithSensitiveWritable(emailEnrichmentScopeColumns, eq(emailEnrichments.messageId, id)));
      await tx.update(emailDismissals).set({ messageId: null }).where(combineWithSensitiveWritable(emailDismissalScopeColumns, eq(emailDismissals.messageId, id)));
      const deleted = await tx.delete(emailMessages).where(writable).returning({ id: emailMessages.id });
      return deleted.length > 0;
    });
  }

  async getCachedEmailByProviderIdAndAccount(providerMessageId: string, accountId: string): Promise<EmailMessage | undefined> {
    const [row] = await db.select()
      .from(emailMessages)
      .where(combineWithSensitiveVisible(emailMessageScopeColumns, and(eq(emailMessages.providerMessageId, providerMessageId), eq(emailMessages.accountId, accountId))));
    return row;
  }

  async recordSyncStart(accountId: string, resyncReason?: string): Promise<EmailSyncLog> {
    const [row] = await db.insert(emailSyncLog)
      .values({ accountId, status: "running", resyncReason: resyncReason || null, ...sensitiveOwnershipValues() })
      .returning();
    return row;
  }

  async recordSyncComplete(syncId: number, messagesSynced: number, cursorState?: string, reconciledCount?: number): Promise<EmailSyncLog | undefined> {
    const [row] = await db.update(emailSyncLog)
      .set({
        status: "success",
        syncCompletedAt: new Date(),
        messagesSynced,
        cursorState: cursorState || null,
        reconciledCount: reconciledCount ?? 0,
      })
      .where(combineWithSensitiveWritable(emailSyncLogScopeColumns, eq(emailSyncLog.id, syncId)))
      .returning();
    return row;
  }

  async recordSyncError(syncId: number, errorMessage: string): Promise<EmailSyncLog | undefined> {
    const [row] = await db.update(emailSyncLog)
      .set({
        status: "error",
        syncCompletedAt: new Date(),
        errorMessage,
      })
      .where(combineWithSensitiveWritable(emailSyncLogScopeColumns, eq(emailSyncLog.id, syncId)))
      .returning();
    return row;
  }

  async getLastSuccessfulSync(accountId: string): Promise<EmailSyncLog | undefined> {
    const [row] = await db.select()
      .from(emailSyncLog)
      .where(combineWithSensitiveVisible(emailSyncLogScopeColumns, and(eq(emailSyncLog.accountId, accountId), eq(emailSyncLog.status, "success"))))
      .orderBy(desc(emailSyncLog.syncCompletedAt))
      .limit(1);
    return row;
  }

  async getSyncHealth(): Promise<Array<{ accountId: string; lastSuccess: Date | null; lastError: string | null; totalSynced: number; totalReconciled: number; orphaned: boolean }>> {
    const rows = await db.execute(sql`
      WITH visible_logs AS (
        SELECT *
        FROM email_sync_log
        WHERE ${combineWithSensitiveVisible(emailSyncLogScopeColumns)}
      ), latest_logs AS (
        SELECT DISTINCT ON (account_id)
          account_id,
          status,
          error_message
        FROM visible_logs
        ORDER BY account_id, sync_completed_at DESC NULLS LAST, id DESC
      )
      SELECT
        visible_logs.account_id,
        MAX(CASE WHEN visible_logs.status = 'success' THEN visible_logs.sync_completed_at END) as last_success,
        CASE WHEN latest_logs.status = 'error' THEN latest_logs.error_message ELSE NULL END as last_error,
        COALESCE(SUM(CASE WHEN visible_logs.status = 'success' THEN visible_logs.messages_synced ELSE 0 END), 0)::int as total_synced,
        COALESCE(SUM(CASE WHEN visible_logs.status = 'success' THEN visible_logs.reconciled_count ELSE 0 END), 0)::int as total_reconciled
      FROM visible_logs
      LEFT JOIN latest_logs ON latest_logs.account_id = visible_logs.account_id
      GROUP BY visible_logs.account_id, latest_logs.status, latest_logs.error_message
    `);
    const connectedGoogleRows = await db.select({ accountId: connectedAccounts.accountId })
      .from(connectedAccounts)
      .where(combineWithSensitiveVisible(connectedAccountScopeColumns, eq(connectedAccounts.provider, "google")));
    const connectedGoogleIds = new Set(connectedGoogleRows.map(row => row.accountId));

    const logResults = (rows.rows as any[]).map(r => ({
      accountId: r.account_id,
      lastSuccess: r.last_success ? new Date(r.last_success) : null,
      lastError: r.last_error || null,
      totalSynced: Number(r.total_synced) || 0,
      totalReconciled: Number(r.total_reconciled) || 0,
      orphaned: !connectedGoogleIds.has(r.account_id),
    }));

    if (logResults.length > 0) {
      return logResults;
    }

    const cursorRows = await db.select().from(emailSyncCursors).where(combineWithSensitiveVisible(emailSyncCursorScopeColumns));
    if (cursorRows.length === 0) {
      return [];
    }

    return cursorRows.map(c => {
      const lastSuccess = c.lastFullSyncAt || c.lastIncrementalSyncAt || null;
      return {
        accountId: c.accountId,
        lastSuccess,
        lastError: c.lastSyncError || null,
        totalSynced: c.messagesCached ?? 0,
        totalReconciled: 0,
        orphaned: !connectedGoogleIds.has(c.accountId),
      };
    });
  }

  async cleanupEmailAccountState(accountId: string): Promise<{ accountId: string; deleted: Record<string, number> }> {
    const deleted = await db.transaction(async (tx) => {
      const triageLogRows = await tx.delete(emailTriageLog).where(eq(emailTriageLog.accountId, accountId)).returning({ id: emailTriageLog.id });
      const dismissalRows = await tx.delete(emailDismissals).where(eq(emailDismissals.accountId, accountId)).returning({ id: emailDismissals.id });
      const enrichmentRows = await tx.delete(emailEnrichments).where(eq(emailEnrichments.accountId, accountId)).returning({ id: emailEnrichments.id });
      const draftRows = await tx.delete(emailDrafts).where(eq(emailDrafts.accountId, accountId)).returning({ id: emailDrafts.id });
      const messageRows = await tx.delete(emailMessages).where(eq(emailMessages.accountId, accountId)).returning({ id: emailMessages.id });
      const cursorRows = await tx.delete(emailSyncCursors).where(eq(emailSyncCursors.accountId, accountId)).returning({ id: emailSyncCursors.id });
      const syncLogRows = await tx.delete(emailSyncLog).where(eq(emailSyncLog.accountId, accountId)).returning({ id: emailSyncLog.id });

      return {
        emailTriageLog: triageLogRows.length,
        emailDismissals: dismissalRows.length,
        emailEnrichments: enrichmentRows.length,
        emailDrafts: draftRows.length,
        emailMessages: messageRows.length,
        emailSyncCursors: cursorRows.length,
        emailSyncLog: syncLogRows.length,
      };
    });
    log.log(`cleanupEmailAccountState accountId=${accountId} deleted=${JSON.stringify(deleted)}`);
    return { accountId, deleted };
  }

  async getTriageLog(sinceHours = 168): Promise<EmailTriageLog[]> {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    return db.select().from(emailTriageLog)
      .where(and(gte(emailTriageLog.triagedAt, since), sql`${emailTriageLog.accountId} IN (SELECT account_id FROM connected_accounts WHERE ${combineWithSensitiveVisible(connectedAccountScopeColumns)})`))
      .orderBy(desc(emailTriageLog.triagedAt))
      .limit(5000);
  }

  // Email draft storage moved to server/email-draft-storage.ts
  // with new schema (uuid IDs, scoped-storage, human-only send gate).

  async getUnenrichedTriagedEmails(limit = 50): Promise<EmailMessage[]> {
    // Returns triaged messages that either:
    // 1. Have no enrichment at all (never enriched), OR
    // 2. Are newer than the existing enrichment (stale enrichment — thread got new messages)
    return db.select()
      .from(emailMessages)
      .where(combineWithSensitiveVisible(
        emailMessageScopeColumns,
        sql`${emailMessages.triageStatus} = 'triaged'
          AND ${emailMessages.ownerUserId} IS NOT NULL
          AND ${emailMessages.principalAccountId} IS NOT NULL
          AND ${emailMessages.date} > NOW() - INTERVAL '30 days'
          AND (
            NOT EXISTS (
              SELECT 1 FROM email_enrichments ee
              WHERE ee.provider_thread_id = ${emailMessages.providerThreadId}
                AND ee.account_id = ${emailMessages.accountId}
            )
            OR EXISTS (
              SELECT 1 FROM email_enrichments ee
              WHERE ee.provider_thread_id = ${emailMessages.providerThreadId}
                AND ee.account_id = ${emailMessages.accountId}
                AND ee.updated_at < ${emailMessages.date}
            )
          )`,
      ))
      .orderBy(desc(emailMessages.date))
      .limit(limit);
  }


  async getEmailPipelineCounts(): Promise<{ untriaged: number; awaitingEnrichment: number; reviewReady: number }> {
    // Keep health counts aligned with the actual candidate queries.
    // Outbound messages are audit/history, not triage candidates.
    // Dismissed triage states are terminal and excluded from enrichment/review counts.
    const scopedRecent = combineWithSensitiveVisible(emailMessageScopeColumns,
      sql`${emailMessages.date} > NOW() - INTERVAL '30 days'`,
    );
    const [row] = await db.select({
      untriaged: sql<number>`COUNT(*) FILTER (
        WHERE ${emailMessages.triageStatus} = 'untriaged'
          AND ${emailMessages.direction} <> 'outbound'
          AND ${emailMessages.ownerUserId} IS NOT NULL
          AND ${emailMessages.principalAccountId} IS NOT NULL
      )::int`,
      awaitingEnrichment: sql<number>`COUNT(*) FILTER (
        WHERE ${emailMessages.triageStatus} = 'triaged'
          AND ${emailMessages.ownerUserId} IS NOT NULL
          AND ${emailMessages.principalAccountId} IS NOT NULL
          AND (${emailEnrichments.id} IS NULL OR ${emailEnrichments.updatedAt} < ${emailMessages.date})
      )::int`,
      reviewReady: sql<number>`COUNT(*) FILTER (
        WHERE ${emailMessages.triageStatus} = 'triaged'
          AND ${emailMessages.ownerUserId} IS NOT NULL
          AND ${emailMessages.principalAccountId} IS NOT NULL
          AND ${emailEnrichments.id} IS NOT NULL
          AND ${emailEnrichments.updatedAt} >= ${emailMessages.date}
      )::int`,
    }).from(emailMessages)
      .leftJoin(emailEnrichments, and(
        eq(emailEnrichments.providerThreadId, emailMessages.providerThreadId),
        eq(emailEnrichments.accountId, emailMessages.accountId),
      ))
      .where(scopedRecent);

    return {
      untriaged: Number(row?.untriaged ?? 0),
      awaitingEnrichment: Number(row?.awaitingEnrichment ?? 0),
      reviewReady: Number(row?.reviewReady ?? 0),
    };
  }

  async getLastEmailEnrichment(): Promise<EmailEnrichment | undefined> {
    const [row] = await db.select()
      .from(emailEnrichments)
      .where(combineWithSensitiveVisible(emailEnrichmentScopeColumns))
      .orderBy(desc(emailEnrichments.updatedAt))
      .limit(1);
    return row;
  }

  async upsertEmailEnrichment(data: InsertEmailEnrichment): Promise<EmailEnrichment> {
    const [result] = await db.insert(emailEnrichments)
      .values({ ...data, ...sensitiveOwnershipValues() })
      .onConflictDoUpdate({
        target: [emailEnrichments.providerThreadId, emailEnrichments.accountId],
        set: {
          summary: data.summary,
          decisions: data.decisions,
          actions: data.actions,
          contextSnapshot: data.contextSnapshot,
          dismissed: data.dismissed,
          dismissReason: data.dismissReason,
          model: data.model,
          tokensUsed: data.tokensUsed,
          messageId: data.messageId,
          ...sensitiveOwnershipValues(),
          updatedAt: new Date(),
        },
      })
      .returning();
    return result;
  }

  async getEnrichmentsByThreadIds(threadIds: string[], accountId?: string): Promise<EmailEnrichment[]> {
    if (threadIds.length === 0) return [];
    const conditions = [inArray(emailEnrichments.providerThreadId, threadIds)];
    if (accountId) {
      conditions.push(eq(emailEnrichments.accountId, accountId));
    }
    return db.select()
      .from(emailEnrichments)
      .where(combineWithSensitiveVisible(emailEnrichmentScopeColumns, and(...conditions)));
  }

  async recordEmailDismissal(data: InsertEmailDismissal): Promise<EmailDismissal> {
    const [result] = await db.insert(emailDismissals)
      .values({ ...data, ...sensitiveOwnershipValues() })
      .returning();
    return result;
  }

  async getEmailHistory(filters: { startDate?: Date; endDate?: Date; type?: string }): Promise<EmailDismissal[]> {
    const conditions: ReturnType<typeof eq>[] = [];
    if (filters.startDate) {
      conditions.push(gte(emailDismissals.dismissedAt, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(emailDismissals.dismissedAt, filters.endDate));
    }
    if (filters.type && filters.type !== "all") {
      conditions.push(eq(emailDismissals.dismissedBy, filters.type));
    }
    const userWhere = conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined;
    return db.select()
      .from(emailDismissals)
      .where(combineWithSensitiveVisible(emailDismissalScopeColumns, userWhere))
      .orderBy(desc(emailDismissals.dismissedAt))
      .limit(500);
  }
}

export const storage = new HybridStorage();
