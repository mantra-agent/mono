import { eq } from "drizzle-orm";
import { environmentSourceBindings } from "@shared/models/platforms";
import { db } from "../../db";
import { createLogger } from "../../log";
import { parseRepoSlug } from "../github-pr";
import { listRecentMainMerges } from "../github-timeline";
import { getEnvironmentVersionDocument } from "./release-versioning";

const log = createLogger("BuildExpandContent");

export type BuildExpandContent =
  | { kind: "version_history"; content: string; empty?: undefined }
  | { kind: "main_merges"; content: string; empty?: undefined }
  | { kind: "empty"; content: ""; empty: string };

function firstParagraph(text: string | null | undefined): string | null {
  if (!text) return null;
  const cleaned = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!cleaned) return null;
  // Keep expand copy scannable — one short block, not full PR bodies.
  const singleLine = cleaned.replace(/\s*\n\s*/g, " ").trim();
  if (singleLine.length <= 280) return singleLine;
  return `${singleLine.slice(0, 277).trimEnd()}…`;
}

function formatMainMergesMarkdown(
  merges: Array<{
    number: number;
    title: string;
    body: string | null;
    author: string | null;
    htmlUrl: string;
    mergedAt: string;
  }>,
): string {
  return merges
    .map((merge) => {
      const when = new Date(merge.mergedAt);
      const dateLabel = Number.isNaN(when.getTime())
        ? merge.mergedAt
        : when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const author = merge.author ? ` · ${merge.author}` : "";
      const comment = firstParagraph(merge.body);
      const lines = [
        `**[#${merge.number} ${merge.title}](${merge.htmlUrl})**`,
        `${dateLabel}${author}`,
      ];
      if (comment) lines.push(comment);
      return lines.join("\n");
    })
    .join("\n\n");
}

async function getGithubSourceBinding(environmentId: number): Promise<{ owner: string; repo: string } | null> {
  const [binding] = await db
    .select({
      provider: environmentSourceBindings.provider,
      owner: environmentSourceBindings.owner,
      repo: environmentSourceBindings.repo,
    })
    .from(environmentSourceBindings)
    .where(eq(environmentSourceBindings.environmentId, environmentId))
    .limit(1);

  if (!binding || binding.provider !== "github" || !binding.owner?.trim() || !binding.repo?.trim()) {
    return null;
  }
  return { owner: binding.owner.trim(), repo: binding.repo.trim() };
}

/**
 * Expand content for Build inbox rows:
 * - version history text when VERSION.md releases exist
 * - otherwise recent merges to main with PR comments
 */
export async function getBuildExpandContent(environmentId: number): Promise<BuildExpandContent> {
  const versionDocument = await getEnvironmentVersionDocument(environmentId);
  if (versionDocument.available && versionDocument.content.trim()) {
    return { kind: "version_history", content: versionDocument.content.trim() };
  }

  const binding = await getGithubSourceBinding(environmentId);
  if (!binding) {
    return {
      kind: "empty",
      content: "",
      empty: "No version history or GitHub source binding for this environment.",
    };
  }

  try {
    const ref = parseRepoSlug(`${binding.owner}/${binding.repo}`);
    const merges = await listRecentMainMerges(ref, 15);
    if (merges.length === 0) {
      return {
        kind: "empty",
        content: "",
        empty: "No merges to main yet.",
      };
    }
    return {
      kind: "main_merges",
      content: formatMainMergesMarkdown(merges),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Failed to load main merges for build expand", { environmentId, error: message });
    return {
      kind: "empty",
      content: "",
      empty: "Could not load merges to main.",
    };
  }
}
