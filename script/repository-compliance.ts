import { readFile, readdir, stat } from "fs/promises";
import { basename, extname, join, relative, sep } from "path";
import { fileURLToPath } from "url";

export type RepositoryFileClass =
  | "ordinary_authored"
  | "generated"
  | "vendored"
  | "immutable_migration_history"
  | "compatibility_fixture";

interface ExceptionalEntry {
  paths?: string[];
  glob?: string;
  provenance: string;
  owner: string;
  mutation: string;
  reviewTrigger: string;
}

interface ComplianceManifest {
  version: number;
  inventory: { excludeDirectories: string[] };
  classes: Record<Exclude<RepositoryFileClass, "ordinary_authored">, ExceptionalEntry[]>;
}

export interface RepositoryFileRecord {
  path: string;
  fileClass: RepositoryFileClass;
}

export interface ComplianceBaseline {
  totalFiles: number;
  counts: Record<RepositoryFileClass, number>;
  files: RepositoryFileRecord[];
}

const SOURCE_EXTENSIONS = new Set([".cjs", ".css", ".html", ".js", ".jsx", ".mjs", ".sh", ".sql", ".ts", ".tsx"]);
const PROHIBITED_FILE_NAME = /(^|\.)(spec|test)(\.|$)/i;
const PROHIBITED_DIRECTORY = /(^|\/)(__tests__|fixtures?|snapshots?)(\/|$)/i;
const COMPLIANCE_FILES = new Set([
  "repository-compliance.json",
  "REPOSITORY_COMPLIANCE.md",
  "script/repository-compliance.ts",
  "server-standards-disposition.json",
  "script/server-standards-disposition.ts",
]);

function normalizePath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

function matchesEntry(path: string, entry: ExceptionalEntry): boolean {
  if (entry.paths?.includes(path)) return true;
  if (entry.glob === "migrations/*.sql") {
    return path.startsWith("migrations/") && !path.slice("migrations/".length).includes("/") && path.endsWith(".sql");
  }
  return false;
}

function assertEntry(className: string, entry: ExceptionalEntry): void {
  if ((!entry.paths?.length && !entry.glob) || !entry.provenance.trim() || !entry.owner.trim() || !entry.mutation.trim() || !entry.reviewTrigger.trim()) {
    throw new Error(`repository compliance: ${className} entry lacks path evidence, provenance, owner, mutation, or reviewTrigger`);
  }
}

async function inventory(root: string, excluded: Set<string>): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && excluded.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        result.push(normalizePath(relative(root, absolute)));
      }
    }
  }
  await walk(root);
  return result;
}

export async function validateRepositoryCompliance(root = fileURLToPath(new URL("..", import.meta.url))): Promise<ComplianceBaseline> {
  const manifestPath = join(root, "repository-compliance.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ComplianceManifest;
  if (manifest.version !== 1) throw new Error(`repository compliance: unsupported manifest version ${manifest.version}`);

  const excluded = new Set(manifest.inventory.excludeDirectories);
  const files = await inventory(root, excluded);
  const fileSet = new Set(files);
  const classByPath = new Map<string, RepositoryFileClass>();

  for (const [className, entries] of Object.entries(manifest.classes) as [Exclude<RepositoryFileClass, "ordinary_authored">, ExceptionalEntry[]][]) {
    for (const entry of entries) {
      assertEntry(className, entry);
      const matched = files.filter((path) => matchesEntry(path, entry));
      if (matched.length === 0) throw new Error(`repository compliance: ${className} entry matches no files`);
      for (const path of matched) {
        const existing = classByPath.get(path);
        if (existing) throw new Error(`repository compliance: ${path} is classified as both ${existing} and ${className}`);
        classByPath.set(path, className);
      }
    }
  }

  for (const entry of Object.values(manifest.classes).flat()) {
    for (const path of entry.paths ?? []) {
      if (!fileSet.has(path)) throw new Error(`repository compliance: classified path does not exist: ${path}`);
    }
  }

  const counts: Record<RepositoryFileClass, number> = {
    ordinary_authored: 0,
    generated: 0,
    vendored: 0,
    immutable_migration_history: 0,
    compatibility_fixture: 0,
  };

  const violations: string[] = [];
  const classifiedFiles: RepositoryFileRecord[] = [];
  for (const path of files) {
    const fileClass = classByPath.get(path) ?? "ordinary_authored";
    classifiedFiles.push({ path, fileClass });
    counts[fileClass] += 1;
    if (fileClass !== "ordinary_authored") continue;
    const extension = extname(path);
    if (SOURCE_EXTENSIONS.has(extension) && (PROHIBITED_FILE_NAME.test(basename(path)) || PROHIBITED_DIRECTORY.test(path))) {
      violations.push(`${path}: test/fixture/snapshot-shaped authored source is prohibited by CODING.md`);
    }
  }

  for (const required of COMPLIANCE_FILES) {
    if (!fileSet.has(required)) violations.push(`${required}: compliance contract file is missing`);
  }

  if (violations.length) {
    throw new Error(`repository compliance failed (${violations.length}):\n${violations.map((value) => `- ${value}`).join("\n")}`);
  }

  console.log(`repository compliance valid: ${files.length} files (${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ")})`);
  return { totalFiles: files.length, counts, files: classifiedFiles };
}

if (process.argv[1] && normalizePath(process.argv[1]) === normalizePath(fileURLToPath(import.meta.url))) {
  validateRepositoryCompliance().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
