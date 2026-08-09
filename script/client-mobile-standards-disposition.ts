import { readFile } from "fs/promises";
import { join } from "path";
import type { RepositoryFileClass, RepositoryFileRecord } from "./repository-compliance";

export type ClientMobileStandardsDisposition = "reviewed" | "cured" | "exempted";

interface DispositionEntry {
  id: string;
  status: ClientMobileStandardsDisposition;
  paths?: string[];
  prefixes?: string[];
  directDirectory?: string;
  excludePaths?: string[];
  owner: string;
  principles: string[];
  evidence: string;
  reviewTrigger: string;
}

interface DispositionManifest {
  version: number;
  scopeRoots: string[];
  entries: DispositionEntry[];
}

export interface ClientMobileStandardsDispositionSummary {
  totalFiles: number;
  counts: Record<ClientMobileStandardsDisposition, number>;
  classCounts: Record<RepositoryFileClass, number>;
}

const REQUIRED_FIELDS: (keyof Pick<DispositionEntry, "id" | "owner" | "evidence" | "reviewTrigger">)[] = [
  "id",
  "owner",
  "evidence",
  "reviewTrigger",
];

function isDirectChild(path: string, directory: string): boolean {
  if (!path.startsWith(`${directory}/`)) return false;
  return !path.slice(directory.length + 1).includes("/");
}

function matchesEntry(path: string, entry: DispositionEntry): boolean {
  if (entry.excludePaths?.includes(path)) return false;
  if (entry.paths?.includes(path)) return true;
  if (entry.prefixes?.some((prefix) => path.startsWith(prefix))) return true;
  if (entry.directDirectory && isDirectChild(path, entry.directDirectory)) return true;
  return false;
}

function assertEntry(entry: DispositionEntry): void {
  if (!entry.paths?.length && !entry.prefixes?.length && !entry.directDirectory) {
    throw new Error(`client/mobile standards disposition: ${entry.id || "unnamed entry"} has no path evidence`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!entry[field].trim()) throw new Error(`client/mobile standards disposition: entry lacks ${field}`);
  }
  if (!entry.principles.length || entry.principles.some((principle) => !principle.trim())) {
    throw new Error(`client/mobile standards disposition: ${entry.id} lacks governing principles`);
  }
}

export async function validateClientMobileStandardsDisposition(
  root: string,
  repositoryFiles: readonly RepositoryFileRecord[],
): Promise<ClientMobileStandardsDispositionSummary> {
  const manifest = JSON.parse(await readFile(join(root, "client-mobile-standards-disposition.json"), "utf8")) as DispositionManifest;
  if (manifest.version !== 1) throw new Error(`client/mobile standards disposition: unsupported manifest version ${manifest.version}`);

  const ids = new Set<string>();
  for (const entry of manifest.entries) {
    assertEntry(entry);
    if (ids.has(entry.id)) throw new Error(`client/mobile standards disposition: duplicate entry id ${entry.id}`);
    ids.add(entry.id);
  }

  const scopeFiles = repositoryFiles.filter(({ path }) => manifest.scopeRoots.some((rootPath) => path === rootPath || path.startsWith(`${rootPath}/`)));
  const counts: Record<ClientMobileStandardsDisposition, number> = { reviewed: 0, cured: 0, exempted: 0 };
  const classCounts: Record<RepositoryFileClass, number> = {
    ordinary_authored: 0,
    generated: 0,
    vendored: 0,
    immutable_migration_history: 0,
    compatibility_fixture: 0,
  };
  const violations: string[] = [];

  for (const file of scopeFiles) {
    const matches = manifest.entries.filter((entry) => matchesEntry(file.path, entry));
    if (matches.length !== 1) {
      violations.push(`${file.path}: expected exactly one disposition, found ${matches.length}${matches.length ? ` (${matches.map(({ id }) => id).join(", ")})` : ""}`);
      continue;
    }
    const [entry] = matches;
    if (file.fileClass === "ordinary_authored" && entry.status === "exempted") {
      violations.push(`${file.path}: ordinary authored source cannot be exempted`);
    }
    if (file.fileClass !== "ordinary_authored" && entry.status !== "exempted") {
      violations.push(`${file.path}: exceptional ${file.fileClass} source must use an exempted disposition`);
    }
    counts[entry.status] += 1;
    classCounts[file.fileClass] += 1;
  }

  for (const entry of manifest.entries) {
    if (!scopeFiles.some(({ path }) => matchesEntry(path, entry))) {
      violations.push(`${entry.id}: disposition entry matches no in-scope files`);
    }
  }

  if (violations.length) {
    throw new Error(`client/mobile standards disposition failed (${violations.length}):\n${violations.map((value) => `- ${value}`).join("\n")}`);
  }

  return { totalFiles: scopeFiles.length, counts, classCounts };
}
