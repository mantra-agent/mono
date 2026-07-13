import { desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { createLogger } from "../../log";
import { chatCompletion } from "../../model-client";
import { ACTIVITY_WORK } from "../../job-profiles";
import { environmentPromotionReleases } from "@shared/models/platforms";
import {
  getRepositoryFile,
  updateRepositoryFile,
  type PublishCommit,
  type RepoRef,
} from "../github-pr";

const log = createLogger("ReleaseVersioning");

export const RELEASE_ENVIRONMENT_ID = 12;
export const VERSION_FILE_PATH = "VERSION.md";

export type VersionIncrement = "minor" | "major" | "flagship";

export interface ReleaseNotes {
  newFeatures: string[];
  improvements: string[];
  fixes: string[];
}

export interface ReleaseDraft {
  increment: VersionIncrement;
  currentVersion: string;
  nextVersion: string;
  notes: ReleaseNotes;
  markdown: string;
  fileUrl: string;
}

function parseVersion(version: string): { flagship: number; major: number; minor: number } {
  const match = version.trim().match(/^(\d+)\.(\d)(\d)$/);
  if (!match) return { flagship: 0, major: 0, minor: 0 };
  return { flagship: Number(match[1]), major: Number(match[2]), minor: Number(match[3]) };
}

export function incrementVersion(current: string, increment: VersionIncrement): string {
  const parsed = parseVersion(current);
  if (increment === "flagship") return `${parsed.flagship + 1}.00`;
  if (increment === "major") {
    if (parsed.major >= 9) return `${parsed.flagship + 1}.00`;
    return `${parsed.flagship}.${parsed.major + 1}0`;
  }
  if (parsed.minor < 9) return `${parsed.flagship}.${parsed.major}${parsed.minor + 1}`;
  if (parsed.major >= 9) return `${parsed.flagship + 1}.00`;
  return `${parsed.flagship}.${parsed.major + 1}0`;
}

function cleanItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);
}

function parseNotes(content: string): ReleaseNotes {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  return {
    newFeatures: cleanItems(parsed.newFeatures),
    improvements: cleanItems(parsed.improvements),
    fixes: cleanItems(parsed.fixes),
  };
}

async function generateNotes(commits: PublishCommit[], runId: string): Promise<ReleaseNotes> {
  const result = await chatCompletion({
    activity: ACTIVITY_WORK,
    metadata: { source: "release-versioning", runId },
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 2400,
    messages: [
      {
        role: "system",
        content:
          "Generate product release notes from git commits. Return JSON with arrays newFeatures, improvements, fixes. Use mutually exclusive categories. A system may appear only once across all categories. New Features are genuinely new systems. Enhancements to existing systems belong under Improvements. Fixes restore broken behavior. Consolidate related commits into the resulting current state. Use concise customer-facing language, omit implementation trivia, and never invent behavior.",
      },
      {
        role: "user",
        content: commits.map((commit) => `${commit.shortSha} ${commit.message}`).join("\n"),
      },
    ],
  });
  return parseNotes(result.content);
}

function renderSection(title: string, items: string[]): string {
  const body = items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None.";
  return `## ${title}\n\n${body}`;
}

function renderRelease(version: string, promotedAt: string, commitSha: string, notes: ReleaseNotes): string {
  return [
    `# ${version}`,
    "",
    `**Published:** ${promotedAt}`,
    `**Commit:** \`${commitSha}\``,
    "",
    renderSection("NEW FEATURES", notes.newFeatures),
    "",
    renderSection("IMPROVEMENTS", notes.improvements),
    "",
    renderSection("FIXES", notes.fixes),
  ].join("\n");
}

async function latestRelease() {
  const [release] = await db
    .select()
    .from(environmentPromotionReleases)
    .where(eq(environmentPromotionReleases.environmentId, RELEASE_ENVIRONMENT_ID))
    .orderBy(desc(environmentPromotionReleases.promotedAt))
    .limit(1);
  return release ?? null;
}

export async function buildReleaseDraft(
  repo: RepoRef,
  commits: PublishCommit[],
  increment: VersionIncrement,
  runId: string,
  targetCommitSha: string,
): Promise<ReleaseDraft> {
  const latest = await latestRelease();
  const currentVersion = latest?.version ?? "0.00";
  const nextVersion = incrementVersion(currentVersion, increment);
  const notes = await generateNotes(commits, runId);
  const promotedAt = new Date().toISOString();
  const releaseEntry = renderRelease(nextVersion, promotedAt, targetCommitSha, notes);
  const existing = await getRepositoryFile(repo, VERSION_FILE_PATH, "live");
  const history = existing?.content.trim();
  const markdown = history ? `${releaseEntry}\n\n---\n\n${history}\n` : `${releaseEntry}\n`;
  return {
    increment,
    currentVersion,
    nextVersion,
    notes,
    markdown,
    fileUrl: `https://github.com/${repo.owner}/${repo.repo}/blob/live/${VERSION_FILE_PATH}`,
  };
}

export async function publishVersionFile(
  repo: RepoRef,
  draft: ReleaseDraft,
  liveCommitSha: string,
): Promise<{ commitSha: string; fileUrl: string }> {
  const result = await updateRepositoryFile(repo, {
    path: VERSION_FILE_PATH,
    branch: "live",
    content: draft.markdown,
    message: `docs: publish ${draft.nextVersion} release notes`,
    expectedBranchSha: liveCommitSha,
  });
  return { commitSha: result.commitSha, fileUrl: draft.fileUrl };
}

export async function recordSuccessfulRelease(input: {
  publishRunId: string;
  actorUserId: string;
  draft: ReleaseDraft;
  promotedCommitSha: string;
  versionFileCommitSha: string;
  deploymentId: string | null;
}): Promise<void> {
  await db.insert(environmentPromotionReleases).values({
    environmentId: RELEASE_ENVIRONMENT_ID,
    publishRunId: input.publishRunId,
    version: input.draft.nextVersion,
    incrementKind: input.draft.increment,
    promotedCommitSha: input.promotedCommitSha,
    versionFileCommitSha: input.versionFileCommitSha,
    versionFilePath: VERSION_FILE_PATH,
    versionFileUrl: input.draft.fileUrl,
    releaseNotes: input.draft.notes,
    deploymentId: input.deploymentId,
    promotedByUserId: input.actorUserId,
  }).onConflictDoNothing({ target: environmentPromotionReleases.publishRunId });
  log.info("Recorded successful versioned release", {
    runId: input.publishRunId,
    version: input.draft.nextVersion,
    promotedCommitSha: input.promotedCommitSha,
  });
}

export async function getReleaseVersionSummary(repo: RepoRef | null) {
  const latest = await latestRelease();
  return {
    currentVersion: latest?.version ?? "0.00",
    latestRelease: latest
      ? {
          version: latest.version,
          increment: latest.incrementKind as VersionIncrement,
          promotedCommitSha: latest.promotedCommitSha,
          promotedAt: latest.promotedAt.toISOString(),
          versionFileUrl: latest.versionFileUrl,
        }
      : null,
    versionFileUrl: latest?.versionFileUrl ?? (repo ? `https://github.com/${repo.owner}/${repo.repo}/blob/live/${VERSION_FILE_PATH}` : null),
  };
}
