import { readFile, writeFile, readdir, stat, mkdir, realpath } from "fs/promises";
import { join, resolve, dirname } from "path";
import { objectStorageService } from "../../object_storage";
import { ObjectPermission } from "../../object_storage/objectAcl";
import { WORKSPACE_DIR } from "../../paths";
import { pathExists, resolveWorkspacePath } from "../../fs-utils";
import { createLogger } from "../../log";
import { scratchEditFailure, inputFailure } from "../../tool-failure";
import type { ToolHandler } from "../contracts";

const toolExec = createLogger("ToolExec");

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function matchesGlob(str: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(str);
}

/**
 * Resolve a scratch write/edit path, enforcing that any path under repos/ is a
 * clone owned by the current session (the same endsWith(sessionId) ownership
 * check the git tool enforces). Returns the resolved absolute path or null when
 * the path escapes the workspace or the repository clone is not session-owned.
 */
async function resolveScratchWritePath(filePath: string, sessionId: unknown): Promise<string | null> {
  const resolved = resolveWorkspacePath(filePath);
  if (!resolved) return null;

  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const repositoryDirectory = normalized.match(/^repos\/([^/]+)(?:\/|$)/)?.[1];
  if (!repositoryDirectory) return resolved;
  if (typeof sessionId !== "string" || !repositoryDirectory.endsWith(`-${sessionId.slice(0, 8)}`)) return null;

  const repositoryRoot = await realpath(resolve(WORKSPACE_DIR, "repos", repositoryDirectory));
  const boundary = `${repositoryRoot}/`;
  let existingAncestor = resolved;
  while (existingAncestor !== repositoryRoot) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      return canonicalAncestor === repositoryRoot || canonicalAncestor.startsWith(boundary) ? resolved : null;
    } catch (error: any) {
      if (error?.code !== "ENOENT") return null;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return null;
      existingAncestor = parent;
    }
  }
  return resolved;
}

/** Scratch workspace + DOCX authoring handlers. */
export const workspaceTools: Record<string, ToolHandler> = {
  async read_scratch(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    const resolved = resolveWorkspacePath(filePath);
    if (!resolved) return { result: `Path escapes workspace: ${filePath}`, error: true, failure: inputFailure("scratch_path_denied", "Path escapes workspace") };
    if (!await pathExists(resolved)) return { result: `File not found: ${filePath}`, error: true, failure: inputFailure("scratch_not_found", "File not found") };

    try {
      const s = await stat(resolved);
      if (s.isDirectory()) return { result: `Path is a directory, not a file: ${filePath}`, error: true, failure: inputFailure("scratch_not_found", "Path is a directory") };

      const content = await readFile(resolved, "utf-8");
      const lines = content.split("\n");
      const offset = Math.max(0, (args.offset || 1) - 1);
      const limit = args.limit || 1000;
      const sliced = lines.slice(offset, offset + limit);
      const totalLines = lines.length;

      let result = sliced.join("\n");
      if (offset > 0 || offset + limit < totalLines) {
        result = `[Showing lines ${offset + 1}-${Math.min(offset + limit, totalLines)} of ${totalLines}]\n${result}`;
      }
      return { result };
    } catch (err: any) {
      return { result: `Error reading file: ${err.message}`, error: true };
    }
  },

  async write_scratch(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    const content = args.content;
    if (content === undefined || content === null) return { result: "Missing file content", error: true };

    const resolved = await resolveScratchWritePath(filePath, args._sessionId);
    if (!resolved) return { result: `Write path is outside the current session-owned workspace: ${filePath}`, error: true, failure: inputFailure("scratch_path_denied", "Write path outside session workspace") };

    try {
      const dir = dirname(resolved);
      await mkdir(dir, { recursive: true });
      await writeFile(resolved, content, "utf-8");
      return { result: `File written: ${filePath} (${content.length} bytes)` };
    } catch (err: any) {
      return { result: `Error writing file: ${err.message}`, error: true };
    }
  },

  async edit_scratch(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    const oldString = args.old_string;
    const newString = args.new_string;
    if (oldString === undefined) return { result: "Missing old_string", error: true };
    if (newString === undefined) return { result: "Missing new_string", error: true };

    const resolved = await resolveScratchWritePath(filePath, args._sessionId);
    if (!resolved) return { result: `Edit path is outside the current session-owned workspace: ${filePath}`, error: true, failure: inputFailure("scratch_path_denied", "Edit path outside session workspace") };
    if (!await pathExists(resolved)) return { result: `File not found: ${filePath}`, error: true, failure: inputFailure("scratch_not_found", "File not found") };

    try {
      const content = await readFile(resolved, "utf-8");
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        return {
          result: `old_string not found in ${filePath}`,
          error: true,
          failure: scratchEditFailure("scratch_edit_not_found", resolved),
        };
      }

      const replaceAll = args.replace_all === true;
      if (occurrences > 1 && !replaceAll) {
        return {
          result: `old_string found ${occurrences} times in ${filePath}. Use replace_all: true to replace all, or provide more context to make it unique.`,
          error: true,
          failure: scratchEditFailure("scratch_edit_ambiguous", resolved),
        };
      }

      const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
      await writeFile(resolved, updated, "utf-8");
      const replacements = replaceAll ? occurrences : 1;
      return { result: `File edited: ${filePath} (${replacements} replacement${replacements > 1 ? "s" : ""})` };
    } catch (err: any) {
      return { result: `Error editing file: ${err.message}`, error: true };
    }
  },

  async list_scratch(args) {
    const dirPath = args.path || ".";

    const resolved = resolveWorkspacePath(dirPath);
    if (!resolved) return { result: `Path escapes workspace: ${dirPath}`, error: true, failure: inputFailure("scratch_path_denied", "Path escapes workspace") };
    if (!await pathExists(resolved)) return { result: `Directory not found: ${dirPath}`, error: true, failure: inputFailure("scratch_not_found", "Directory not found") };

    try {
      const s = await stat(resolved);
      if (!s.isDirectory()) return { result: `Not a directory: ${dirPath}`, error: true };

      const entries = await readdir(resolved);
      const items = await Promise.all(entries.map(async name => {
        try {
          const s = await stat(join(resolved, name));
          const type = s.isDirectory() ? "dir" : "file";
          const size = s.isDirectory() ? "" : ` (${formatSize(s.size)})`;
          return `${type === "dir" ? "📁" : "📄"} ${name}${size}`;
        } catch {
          return `? ${name}`;
        }
      }));

      return { result: `${dirPath}/\n${items.join("\n")}` };
    } catch (err: any) {
      return { result: `Error listing directory: ${err.message}`, error: true };
    }
  },

  async read_docx(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    try {
      let source: string | Buffer;
      if (filePath.startsWith("/objects/")) {
        const { requireCurrentUserPrincipal } = await import("../../principal-context");
        const principal = requireCurrentUserPrincipal();
        const objectPath = filePath.split("?")[0];
        const objectFile = await objectStorageService.getObjectEntityFile(objectPath, principal);
        const canRead = await objectStorageService.canAccessObjectEntity({
          principal,
          objectFile,
          requestedPermission: ObjectPermission.READ,
        });
        if (!canRead) return { result: `Access denied: ${filePath}`, error: true };

        const metadata = await objectFile.getMetadata();
        const maxDocxBytes = 25 * 1024 * 1024;
        if (typeof metadata.contentLength === "number" && metadata.contentLength > maxDocxBytes) {
          return { result: `DOCX exceeds the 25 MB read limit: ${filePath}`, error: true };
        }
        const [buffer] = await objectFile.download();
        if (buffer.length > maxDocxBytes) {
          return { result: `DOCX exceeds the 25 MB read limit: ${filePath}`, error: true };
        }
        source = buffer;
      } else {
        const resolved = resolveWorkspacePath(filePath);
        if (!resolved) return { result: `Path escapes workspace: ${filePath}`, error: true };
        if (!await pathExists(resolved)) return { result: `File not found: ${filePath}`, error: true };
        const s = await stat(resolved);
        if (s.isDirectory()) return { result: `Path is a directory, not a file: ${filePath}`, error: true };
        source = resolved;
      }

      const mode = args.mode || "text";

      if (mode === "rich" || mode === "annotated") {
        const { readDocxRich, formatRichContent } = await import("../../docx-utils");
        const content = await readDocxRich(source);
        const formatted = formatRichContent(content, mode === "annotated" ? "annotated" : "structured");

        const summary: string[] = [];
        summary.push(`Document: ${filePath}`);
        if (content.comments.length > 0) summary.push(`Comments: ${content.comments.length}`);
        if (content.trackedChanges.length > 0) {
          const ins = content.trackedChanges.filter(c => c.type === "insertion").length;
          const del = content.trackedChanges.filter(c => c.type === "deletion").length;
          summary.push(`Tracked changes: ${ins} insertions, ${del} deletions`);
        }
        summary.push(`Paragraphs: ${content.paragraphs.length}`);

        return { result: `${summary.join(" | ")}\n\n${formatted}` };
      }

      const { readDocxRich } = await import("../../docx-utils");
      const content = await readDocxRich(source);
      const text = content.paragraphs
        .map(p => p.runs.map(r => r.text).join(""))
        .join("\n");
      if (!text || text.trim().length === 0) {
        return { result: `Document is empty or contains no extractable text: ${filePath}` };
      }
      return { result: text };
    } catch (err: any) {
      if (err.message?.includes("Unrecognised") || err.message?.includes("not a zip") || err.message?.includes("Invalid") || err.message?.includes("not a valid zip")) {
        return { result: `File does not appear to be a valid .docx file: ${filePath}`, error: true };
      }
      return { result: `Error reading docx: ${err.message}`, error: true };
    }
  },

  async write_docx(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    const content = args.content;
    if (content === undefined || content === null) return { result: "Missing content", error: true };

    const resolved = resolveWorkspacePath(filePath);
    if (!resolved) return { result: `Path escapes workspace: ${filePath}`, error: true };

    try {
      const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");

      const lines = content.split("\n");
      const children: (typeof Paragraph.prototype)[] = [];

      for (const line of lines) {
        if (line.startsWith("#### ")) {
          children.push(new Paragraph({ text: line.slice(5).trim(), heading: HeadingLevel.HEADING_4 }));
        } else if (line.startsWith("### ")) {
          children.push(new Paragraph({ text: line.slice(4).trim(), heading: HeadingLevel.HEADING_3 }));
        } else if (line.startsWith("## ")) {
          children.push(new Paragraph({ text: line.slice(3).trim(), heading: HeadingLevel.HEADING_2 }));
        } else if (line.startsWith("# ")) {
          children.push(new Paragraph({ text: line.slice(2).trim(), heading: HeadingLevel.HEADING_1 }));
        } else {
          children.push(new Paragraph({ children: [new TextRun(line)] }));
        }
      }

      const doc = new Document({ sections: [{ children }] });
      const buffer = await Packer.toBuffer(doc);

      const dir = join(resolved, "..");
      await mkdir(dir, { recursive: true });
      await writeFile(resolved, buffer);

      return { result: `Word document written: ${filePath} (${buffer.length} bytes, ${children.length} paragraphs)` };
    } catch (err: any) {
      return { result: `Error writing docx: ${err.message}`, error: true };
    }
  },

  async edit_docx(args) {
    const filePath = args.path;
    if (!filePath) return { result: "Missing file path", error: true };

    const replacements = args.replacements;
    if (!replacements || !Array.isArray(replacements) || replacements.length === 0) {
      return { result: "Missing or empty replacements array", error: true };
    }

    const resolved = resolveWorkspacePath(filePath);
    if (!resolved) return { result: `Path escapes workspace: ${filePath}`, error: true };
    if (!await pathExists(resolved)) return { result: `Source file not found: ${filePath}`, error: true };

    const outputPath = args.output_path || filePath;
    const resolvedOutput = resolveWorkspacePath(outputPath);
    if (!resolvedOutput) return { result: `Output path escapes workspace: ${outputPath}`, error: true };

    try {
      const { editDocxInPlace } = await import("../../docx-utils");
      const result = await editDocxInPlace(resolved, resolvedOutput, replacements);
      return {
        result: `Document edited: ${outputPath} (${result.replacementsMade} replacement${result.replacementsMade !== 1 ? "s" : ""} made, ${result.bytesWritten} bytes). All original formatting preserved.`,
      };
    } catch (err: any) {
      if (err.message?.includes("not a valid zip") || err.message?.includes("Corrupted")) {
        return { result: `File does not appear to be a valid .docx file: ${filePath}`, error: true };
      }
      return { result: `Error editing docx: ${err.message}`, error: true };
    }
  },

  async clone_docx(args) {
    const sourcePath = args.source_path;
    if (!sourcePath) return { result: "Missing source_path", error: true };

    const outputPath = args.output_path;
    if (!outputPath) return { result: "Missing output_path", error: true };

    const content = args.content;
    if (content === undefined || content === null) return { result: "Missing content", error: true };

    const resolvedSource = resolveWorkspacePath(sourcePath);
    if (!resolvedSource) return { result: `Source path escapes workspace: ${sourcePath}`, error: true };
    if (!await pathExists(resolvedSource)) return { result: `Source file not found: ${sourcePath}`, error: true };

    const resolvedOutput = resolveWorkspacePath(outputPath);
    if (!resolvedOutput) return { result: `Output path escapes workspace: ${outputPath}`, error: true };

    try {
      const { cloneDocxWithContent } = await import("../../docx-utils");
      const result = await cloneDocxWithContent(resolvedSource, resolvedOutput, content);
      return {
        result: `Document created from template: ${outputPath} (${result.bytesWritten} bytes, ${result.paragraphsWritten} paragraphs). Styles, fonts, page layout, and theme from ${sourcePath} preserved.`,
      };
    } catch (err: any) {
      if (err.message?.includes("not a valid zip") || err.message?.includes("Corrupted")) {
        return { result: `Source file does not appear to be a valid .docx: ${sourcePath}`, error: true };
      }
      return { result: `Error cloning docx: ${err.message}`, error: true };
    }
  },

  async search_scratch(args) {
    const pattern = args.pattern;
    if (!pattern) return { result: "Missing search pattern", error: true };

    try {
      const results: string[] = [];
      const maxResults = args.limit || 50;

      const walkDir = async (dir: string, relBase: string) => {
        if (results.length >= maxResults) return;
        try {
          const entries = await readdir(dir);
          for (const entry of entries) {
            if (results.length >= maxResults) return;
            if (entry.startsWith(".") && entry !== ".") continue;
            const fullPath = join(dir, entry);
            const relPath = relBase ? `${relBase}/${entry}` : entry;
            try {
              const s = await stat(fullPath);
              if (s.isDirectory()) {
                if (entry === "node_modules" || entry === ".git") continue;
                await walkDir(fullPath, relPath);
              } else if (matchesGlob(entry, pattern) || matchesGlob(relPath, pattern)) {
                results.push(relPath);
              }
            } catch (err) { toolExec.warn("glob entry stat failed", err); }
          }
        } catch (err) { toolExec.warn("glob readdir failed", err); }
      }

      await walkDir(WORKSPACE_DIR, "");

      if (results.length === 0) return { result: `No files matching "${pattern}"` };
      return { result: `Found ${results.length} file${results.length > 1 ? "s" : ""}:\n${results.join("\n")}` };
    } catch (err: any) {
      return { result: `Error searching files: ${err.message}`, error: true };
    }
  },
};
