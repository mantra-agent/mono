import { extname } from "path";
import { eq } from "drizzle-orm";
import { strategyArtifacts } from "@shared/models/strategy";
import { TEXT_ARTIFACT_MIME_MAP } from "../../lib/mime";
import { objectStorageService } from "../../object_storage";
import type { ToolHandlerResult } from "../contracts";
import type { StrategySubHandler } from "./strategy-core";

const MAX_ARTIFACT_SIZE = 50 * 1024;

export const strategyArtifactHandlers: Record<string, StrategySubHandler> = {
  list_artifacts: listArtifacts,
  get_artifact: getArtifact,
  create_artifact: createArtifact,
  delete_artifact: deleteArtifact,
};

async function listArtifacts(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.goalId) return missingStrategyId();
  const artifacts = await storage.getArtifacts(args.goalId);
  if (artifacts.length === 0) return { result: "No artifacts for this strategy." };
  const lines = artifacts.map((artifact: any) => {
    const sizeKB = (artifact.fileSize / 1024).toFixed(1);
    return `- **${artifact.fileName}** (${sizeKB} KB, ${artifact.contentType}, id: ${artifact.id}, path: ${artifact.objectPath})`;
  });
  return { result: `${artifacts.length} artifacts:\n${lines.join("\n")}\n\nUse get_artifact with the artifact id to read its content.` };
}

async function getArtifact(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.id) return { result: "Missing artifact id. Call list_artifacts first.", error: true };
  const goalArtifacts = args.goalId ? await storage.getArtifacts(args.goalId) : [];
  let artifact = goalArtifacts.find((candidate: any) => candidate.id === args.id);
  if (!artifact) {
    const { db } = await import("../../db");
    const [found] = await db.select().from(strategyArtifacts).where(eq(strategyArtifacts.id, args.id));
    artifact = found || null;
  }
  if (!artifact) return { result: `Artifact ${args.id} not found`, error: true };

  const textExtensions = [".md", ".txt", ".json", ".yaml", ".yml", ".xml", ".csv", ".js", ".ts", ".py", ".sh", ".toml", ".ini", ".html", ".css", ".svg", ".log"];
  const textTypes = ["text/", "application/json", "application/xml", "application/javascript", "application/yaml", "application/toml"];
  const isText = textTypes.some((type) => artifact.contentType.startsWith(type)) ||
    (artifact.contentType === "application/octet-stream" && textExtensions.some((extension) => artifact.fileName.toLowerCase().endsWith(extension)));
  if (!isText) return { result: `Artifact "${artifact.fileName}" is a binary file (${artifact.contentType}) and cannot be read as text. View it in the Strategy UI instead.`, error: true };

  try {
    const objectPath = artifact.objectPath.startsWith("/objects/") ? artifact.objectPath : `/objects/${artifact.objectPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
    const [buffer] = await objectFile.download();
    const content = buffer.toString("utf-8");
    const offset = typeof args.offset === "number" && args.offset >= 0 ? args.offset : 0;
    const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : undefined;
    if (offset > 0 || limit !== undefined) {
      const slice = limit !== undefined ? content.slice(offset, offset + limit) : content.slice(offset);
      return { result: `**${artifact.fileName}** (offset=${offset}, showing ${slice.length} of ${content.length} chars):\n\n${slice}` };
    }
    if (content.length > 50000) {
      const { indexAndArchiveWithFallback } = await import("../../content-indexer");
      const reference = await indexAndArchiveWithFallback({ content, sourceType: "file", sourceLabel: artifact.fileName });
      return { result: `**${artifact.fileName}** (${content.length} chars):\n\n${reference}` };
    }
    return { result: `**${artifact.fileName}** (${content.length} chars):\n\n${content}` };
  } catch (error: any) {
    return { result: `Failed to read artifact "${artifact.fileName}": ${error.message}`, error: true };
  }
}

async function createArtifact(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.goalId) return missingStrategyId();
  if (!args.fileName) return { result: "Missing fileName (e.g. 'analysis.md')", error: true };
  if (args.content === undefined || args.content === null) return { result: "Missing content — provide the text content to store", error: true };
  if (args.content.length > MAX_ARTIFACT_SIZE) {
    return { result: `Content too large (${(args.content.length / 1024).toFixed(1)} KB). Maximum size is ${MAX_ARTIFACT_SIZE / 1024} KB.`, error: true };
  }

  const extension = extname(args.fileName).toLowerCase();
  if (extension && !TEXT_ARTIFACT_MIME_MAP[extension]) {
    return { result: `Unsupported file extension "${extension}". create_artifact only supports text formats: ${Object.keys(TEXT_ARTIFACT_MIME_MAP).join(", ")}`, error: true };
  }
  const contentType = TEXT_ARTIFACT_MIME_MAP[extension] || "text/plain";
  const contentBuffer = Buffer.from(args.content, "utf-8");
  try {
    const { objectPath } = await objectStorageService.uploadObjectEntity(contentBuffer, {
      extension: extension || ".md",
      contentType,
    });
    const artifact = await storage.createArtifact({
      goalId: args.goalId,
      fileName: args.fileName,
      fileSize: contentBuffer.length,
      contentType,
      objectPath,
    });
    return { result: `Artifact created: "${artifact.fileName}" (ID: ${artifact.id}, ${(contentBuffer.length / 1024).toFixed(1)} KB)` };
  } catch (error: any) {
    return { result: `Failed to create artifact: ${error.message}`, error: true };
  }
}

async function deleteArtifact(args: Record<string, any>, storage: any): Promise<ToolHandlerResult> {
  if (!args.id) return { result: "Missing artifact id", error: true };
  if (!await storage.deleteArtifact(args.id)) return { result: `Artifact ${args.id} not found`, error: true };
  return { result: `Artifact ${args.id} deleted` };
}

function missingStrategyId(): ToolHandlerResult {
  return { result: "Missing strategyId. Call list_scenarios first to get available strategy IDs.", error: true };
}
