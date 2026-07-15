// Use createLogger for logging ONLY
import { db, fnv1a32 } from "./db";
import { createLogger } from "./log";
import {
  users, skills, skillReferences, skillRuns, skillFailureDismissals, promptModules, promptModuleVersions, systemSettings, insertSkillSchema,
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
import { eq, ne, desc, gte, count, sql, inArray, or, lte, and, type SQL } from "drizzle-orm";
import { fileIssueStorage, fileApiCallStorage } from "./file-storage";
import { peopleStorage } from "./people-storage";
import { getCurrentPrincipalOrSystem } from "./principal-context";
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
  updateUser(id: string, updates: Partial<Omit<User, "id">>): Promise<User | undefined>;
  getUserCount(): Promise<number>;

  createApiCall(call: InsertApiCall): Promise<ApiCall>;
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
  getIssue(id: number): Promise<Issue | undefined>;
  createIssue(issue: InsertIssue): Promise<Issue>;
  updateIssue(id: number, updates: Partial<InsertIssue>): Promise<Issue | undefined>;
  deleteIssue(id: number): Promise<boolean>;

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
  incrementSkillSuccess(id: string): Promise<void>;
  incrementSkillFailure(id: string): Promise<void>;
  // insertSkillScore, getLatestSkillScore, getSkillScores, getSkillLastRuns removed — skill_scores superseded by skill_runs
  getSkillFailedNames(): Promise<{ name: string; scoredAt: string }[]>;
  dismissSkillFailure(skillName: string): Promise<void>;

  insertSkillRun(data: { skillName: string; sessionId: string; status?: SkillRunStatus }): Promise<SkillRun>;
  updateSkillRunStatus(sessionId: string, status: SkillRunStatus, durationMs?: number, failureReason?: string): Promise<SkillRun | null>;
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
  getSkillRuns(skillName: string, limit?: number): Promise<SkillRun[]>;
  getSkillRunLastRuns(): Promise<Record<string, string>>;
  getLatestScoredSkillRun(skillName: string): Promise<SkillRun | null>;
  healStuckSkillRuns(): Promise<number>;
  dismissLogErrors(): Promise<void>;
  getLogErrorDismissedAt(): Promise<string | null>;



  claimVoiceSessionActive(input: { sessionId: string; chatSessionId: string; requestId: string; bootId: string; principal: Principal; reconnect: boolean }): Promise<VoiceLeaseClaimResult>;
  completeVoiceSessionStart(sessionId: string, bootId: string, response: Record<string, unknown>): Promise<VoiceSessionActive | undefined>;
  getVoiceSessionStartByRequest(requestId: string, principal: Principal): Promise<VoiceSessionActive | undefined>;
  getOwnedActiveVoiceSession(sessionId: string, bootId: string): Promise<VoiceSessionActive | undefined>;
  endVoiceSessionActive(sessionId: string, status: "complete" | "abandoned", authority: VoiceLeaseMutationAuthority): Promise<void>;
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
  getCachedEmailByProviderIdAndAccount(providerMessageId: string, accountId: string): Promise<EmailMessage | undefined>;

  recordSyncStart(accountId: string, resyncReason?: string): Promise<EmailSyncLog>;
  recordSyncComplete(syncId: number, messagesSynced: number, cursorState?: string, reconciledCount?: number): Promise<EmailSyncLog | undefined>;
  recordSyncError(syncId: number, errorMessage: string): Promise<EmailSyncLog | undefined>;
  getLastSuccessfulSync(accountId: string): Promise<EmailSyncLog | undefined>;
  getSyncHealth(): Promise<Array<{ accountId: string; lastSuccess: Date | null; lastError: string | null; totalSynced: number; totalReconciled: number; orphaned: boolean }>>;
  cleanupEmailAccountState(accountId: string): Promise<{ accountId: string; deleted: Record<string, number> }>;

  // Email draft storage moved to server/email-draft-storage.ts

  getUnenrichedTriagedEmails(limit?: number): Promise<EmailMessage[]>;
  getEmailPipelineCounts(): Promise<{ untriaged: number; awaitingEnrichment: number; reviewReady: number; ownerNullEmailMessages: number; systemAwaitingEnrichment: number; visibilityMismatch: boolean }>;
  getLastEmailEnrichment(): Promise<EmailEnrichment | undefined>;
  upsertEmailEnrichment(data: InsertEmailEnrichment): Promise<EmailEnrichment>;
  getEnrichmentsByThreadIds(threadIds: string[], accountId?: string): Promise<EmailEnrichment[]>;
  recordEmailDismissal(data: InsertEmailDismissal): Promise<EmailDismissal>;
  getEmailHistory(filters: { startDate?: Date; endDate?: Date; type?: string }): Promise<EmailDismissal[]>;
}

const log = createLogger("Storage");
const skillScopeColumns = { scope: skills.scope, ownerUserId: skills.ownerUserId, accountId: skills.accountId, vaultId: skills.vaultId };
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

  async getIssue(id: number): Promise<Issue | undefined> {
    return fileIssueStorage.getIssue(id);
  }

  async createIssue(issue: InsertIssue): Promise<Issue> {
    return fileIssueStorage.createIssue(issue);
  }

  async updateIssue(id: number, updates: Partial<InsertIssue>): Promise<Issue | undefined> {
    return fileIssueStorage.updateIssue(id, updates);
  }

  async deleteIssue(id: number): Promise<boolean> {
    return fileIssueStorage.deleteIssue(id);
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
    return combineWithVisibleScope(getCurrentPrincipalOrSystem(), skillScopeColumns, predicate);
  }

  private skillWritable(predicate?: SQL): SQL {
    const principal = getCurrentPrincipalOrSystem();
    if (principalHasPermission(principal, "build:write") || principalHasPermission(principal, "system:write")) {
      return predicate ?? sql`TRUE`;
    }
    return combineWithWritableScope(principal, skillScopeColumns, predicate);
  }

  private promptModuleVisible(predicate?: SQL): SQL {
    return combineWithVisibleScope(getCurrentPrincipalOrSystem(), promptModuleScopeColumns, predicate);
  }

  private promptModuleWritable(predicate?: SQL): SQL {
    const principal = getCurrentPrincipalOrSystem();
    if (principalHasPermission(principal, "build:write") || principalHasPermission(principal, "system:write")) {
      return predicate ?? sql`TRUE`;
    }
    return combineWithWritableScope(principal, promptModuleScopeColumns, predicate);
  }

  private runVisible(predicate?: SQL): SQL {
    return combineWithVisibleScope(getCurrentPrincipalOrSystem(), skillRunScopeColumns, predicate);
  }

  private dismissalVisible(predicate?: SQL): SQL {
    return combineWithVisibleScope(getCurrentPrincipalOrSystem(), skillDismissalScopeColumns, predicate);
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
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), promptModuleScopeColumns),
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
    return Promise.all(rows.map(s => this.enrichSkillWithReferences(s)));
  }

  async getSkill(id: string): Promise<SkillWithReferences | undefined> {
    const [skill] = await db.select().from(skills).where(this.skillVisible(eq(skills.id, id)));
    if (!skill) return undefined;
    return this.enrichSkillWithReferences(skill);
  }

  async getSkillByName(name: string): Promise<SkillWithReferences | undefined> {
    const [skill] = await db.select().from(skills).where(this.skillVisible(eq(skills.name, name)));
    if (!skill) return undefined;
    return this.enrichSkillWithReferences(skill);
  }

  async createSkill(data: InsertSkill): Promise<SkillWithReferences> {
    const normalized = insertSkillSchema.parse(data);
    const { references: refs, ...skillData } = normalized;
    const [created] = await db.insert(skills).values({
      ...skillData,
      allowedTools: [],
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), skillScopeColumns),
    }).returning();
    if (refs && refs.length > 0) {
      await db.insert(skillReferences).values(
        refs.map(r => ({ skillId: created.id, name: r.name, content: r.content }))
      );
    }
    return this.enrichSkillWithReferences(created);
  }

  async updateSkill(id: string, data: Partial<InsertSkill>): Promise<SkillWithReferences | undefined> {
    const { references: refs, ...skillData } = data;
    const updated = await db.transaction(async (tx) => {
      const [result] = await tx.update(skills)
        .set({ ...skillData, updatedAt: new Date(), customized: true })
        .where(this.skillWritable(eq(skills.id, id)))
        .returning();
      if (!result) return undefined;
      if (refs !== undefined) {
        await tx.delete(skillReferences).where(eq(skillReferences.skillId, id));
        if (refs.length > 0) {
          await tx.insert(skillReferences).values(
            refs.map(r => ({ skillId: id, name: r.name, content: r.content }))
          );
        }
      }
      return result;
    });
    if (!updated) return undefined;
    return this.enrichSkillWithReferences(updated);
  }

  async deleteSkill(id: string): Promise<boolean> {
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

    const principal = getCurrentPrincipalOrSystem();
    const ownerClause = principal.actorType === "system" || principal.isAdmin
      ? sql`TRUE`
      : sql`(owner_user_id = ${principal.userId} OR account_id = ${principal.accountId})`;
    const failedFromRuns = await db.execute(sql`
      SELECT f.skill_name, f.scored_at
      FROM (
        SELECT DISTINCT ON (skill_name) skill_name, COALESCE(completed_at, started_at) AS scored_at
        FROM skill_runs
        WHERE ${ownerClause} AND (status = 'failed' OR (pass_rate IS NOT NULL AND pass_rate <= 0.5))
        ORDER BY skill_name, COALESCE(completed_at, started_at) DESC
      ) f
      LEFT JOIN skill_failure_dismissals d ON f.skill_name = d.skill_name
      WHERE d.dismissed_at IS NULL OR d.dismissed_at < f.scored_at
    `);

    const latestRunPerSkill = await db.execute(sql`
      SELECT DISTINCT ON (skill_name) skill_name, status, pass_rate
      FROM skill_runs
      WHERE ${ownerClause}
      ORDER BY skill_name, COALESCE(completed_at, started_at) DESC
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
    const ownerValues = ownedInsertValues(getCurrentPrincipalOrSystem(), skillDismissalScopeColumns);
    await db
      .insert(skillFailureDismissals)
      .values({
        skillName,
        dismissedAt: sql`CURRENT_TIMESTAMP`,
        ...ownerValues,
      })
      .onConflictDoUpdate({
        target: skillFailureDismissals.skillName,
        set: {
          dismissedAt: sql`CURRENT_TIMESTAMP`,
          ...ownerValues,
        },
      });
  }


  async insertSkillRun(data: { skillName: string; sessionId: string; status?: SkillRunStatus }): Promise<SkillRun> {
    const [row] = await db.insert(skillRuns).values({
      skillName: data.skillName,
      sessionId: data.sessionId,
      status: data.status || "running",
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), skillRunScopeColumns),
    }).returning();
    return row;
  }

  async updateSkillRunStatus(sessionId: string, status: SkillRunStatus, durationMs?: number, failureReason?: string): Promise<SkillRun | null> {
    const updates: Record<string, unknown> = { status, completedAt: new Date() };
    if (durationMs !== undefined) updates.durationMs = durationMs;
    if (failureReason !== undefined) updates.failureReason = failureReason;
    const [row] = await db.update(skillRuns)
      .set(updates)
      .where(eq(skillRuns.sessionId, sessionId))
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
      .where(eq(skillRuns.sessionId, sessionId))
      .returning();
    return row ?? null;
  }

  async getSkillRunBySessionId(sessionId: string): Promise<SkillRun | null> {
    const [row] = await db.select().from(skillRuns).where(eq(skillRuns.sessionId, sessionId));
    return row ?? null;
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
        eq(voiceSessionActive.scope, "user"),
      ))
      .limit(1);
    return row;
  }

  async endVoiceSessionActive(sessionId: string, status: "complete" | "abandoned", authority: VoiceLeaseMutationAuthority): Promise<void> {
    await db.update(voiceSessionActive)
      .set({ status, endedAt: new Date(), inflightTurn: 0 })
      .where(voiceLeaseWritablePredicate(sessionId, authority));
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
      .values(entry)
      .onConflictDoNothing()
      .returning();
    log.log(`recordTriagedEmail msgId=${entry.gmailMessageId} tier=${entry.tier}`);
    return created;
  }

  async recordTriagedEmails(entries: InsertEmailTriageLog[]): Promise<void> {
    if (entries.length === 0) return;
    await db.insert(emailTriageLog)
      .values(entries)
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


  async getEmailPipelineCounts(): Promise<{ untriaged: number; awaitingEnrichment: number; reviewReady: number; ownerNullEmailMessages: number; systemAwaitingEnrichment: number; visibilityMismatch: boolean }> {
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

    const [diagnostic] = await db.select({
      ownerNullEmailMessages: sql<number>`COUNT(*) FILTER (
        WHERE (${emailMessages.ownerUserId} IS NULL OR ${emailMessages.principalAccountId} IS NULL)
      )::int`,
      systemAwaitingEnrichment: sql<number>`COUNT(*) FILTER (
        WHERE ${emailMessages.triageStatus} = 'triaged'
          AND (${emailEnrichments.id} IS NULL OR ${emailEnrichments.updatedAt} < ${emailMessages.date})
      )::int`,
    }).from(emailMessages)
      .leftJoin(emailEnrichments, and(
        eq(emailEnrichments.providerThreadId, emailMessages.providerThreadId),
        eq(emailEnrichments.accountId, emailMessages.accountId),
      ))
      .where(sql`${emailMessages.date} > NOW() - INTERVAL '30 days'`);

    const counts = {
      untriaged: Number(row?.untriaged ?? 0),
      awaitingEnrichment: Number(row?.awaitingEnrichment ?? 0),
      reviewReady: Number(row?.reviewReady ?? 0),
      ownerNullEmailMessages: Number(diagnostic?.ownerNullEmailMessages ?? 0),
      systemAwaitingEnrichment: Number(diagnostic?.systemAwaitingEnrichment ?? 0),
      visibilityMismatch: Number(diagnostic?.systemAwaitingEnrichment ?? 0) > Number(row?.awaitingEnrichment ?? 0),
    };

    if (counts.ownerNullEmailMessages > 0) {
      log.error(`email pipeline invariant violation: owner-null email rows in recent pipeline count=${counts.ownerNullEmailMessages}`);
    }
    if (counts.visibilityMismatch) {
      log.error(`email pipeline visibility mismatch: systemAwaitingEnrichment=${counts.systemAwaitingEnrichment} userVisibleAwaitingEnrichment=${counts.awaitingEnrichment}`);
    }

    return counts;
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
