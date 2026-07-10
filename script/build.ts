import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, cp, readdir, writeFile, mkdir, symlink, unlink, chmod } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { execFileSync, execSync } from "child_process";
import { createHash } from "crypto";
import { join } from "path";
import { safeEsmHelperPlugin } from "./safe-esm-helper-plugin";

// Dev mode (set via BUILD_DEV_MODE=true in Dockerfile.dev) skips the heavy
// production-only steps: gitnexus runtime bundling+patches, claude CLI
// bundle, runtime size threshold checks, GitHub push, DB cleanup. The dev
// runtime resolves gitnexus + claude CLI from node_modules instead.
const DEV_MODE = process.env.BUILD_DEV_MODE === "true";

async function pushToGitHub() {
  if (process.env.BUILD_PUSH_TO_GITHUB !== "true") {
    console.log("Skipping GitHub push during build. Set BUILD_PUSH_TO_GITHUB=true to enable.");
    return;
  }

  const repoUrl = process.env.GITHUB_REPO_URL?.trim();
  if (!repoUrl) {
    console.warn("GITHUB_REPO_URL not set — skipping GitHub push");
    return;
  }

  console.log("pushing to GitHub...");
  try {
    const { getAuthenticatedGitUrl } = await import("../server/github-auth");
    const authedUrl = await getAuthenticatedGitUrl(repoUrl);
    execFileSync("git", ["push", authedUrl, "HEAD:refs/heads/main"], {
      stdio: "pipe",
      timeout: 60_000,
    });
    console.log("pushed to GitHub successfully");
  } catch (err: unknown) {
    const code =
      err instanceof Error && "status" in err
        ? (err as { status: number }).status
        : "unknown";
    console.warn(`git push to GitHub failed (non-blocking): exit code ${code}`);
  }
}

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
// NOTE: @modelcontextprotocol/sdk (transitive dep of claude-agent-sdk) is not listed
// because it is not a top-level dependency in package.json and therefore never appears
// in the externals set — esbuild resolves and bundles it automatically.
const allowlist = [
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/sdk",
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
  "@google/generative-ai",
  "@notionhq/client",
  "axios",
  "bcryptjs",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "fast-xml-parser",
  "google-auth-library",
  "googleapis",
  "jsonwebtoken",
  "jszip",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "p-limit",
  "p-retry",
  "pg",
  "plaid",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "yaml",
  "yocto-queue",
  "zod",
  "zod-validation-error",
];

async function runDbCleanup() {
  if (!process.env.DATABASE_URL) return;
  if (process.env.ENABLE_DB_CLEANUP !== "true") {
    console.log("skipping DB cleanup (set ENABLE_DB_CLEANUP=true to run)");
    return;
  }
  console.log("running pre-deploy DB cleanup...");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`
      ALTER TABLE IF EXISTS strategy_move_instances DROP CONSTRAINT IF EXISTS strategy_move_instances_state_id_fkey;
      ALTER TABLE IF EXISTS strategy_simulation_runs DROP CONSTRAINT IF EXISTS strategy_simulation_runs_root_state_id_fkey;
      ALTER TABLE IF EXISTS strategy_move_outcomes DROP CONSTRAINT IF EXISTS strategy_move_outcomes_move_instance_id_fkey;
      ALTER TABLE IF EXISTS strategy_move_outcomes DROP CONSTRAINT IF EXISTS strategy_move_outcomes_resulting_state_id_fkey;
      ALTER TABLE IF EXISTS strategy_states DROP CONSTRAINT IF EXISTS strategy_states_goal_id_fkey;
      ALTER TABLE IF EXISTS strategy_move_instances DROP COLUMN IF EXISTS state_id;
      ALTER TABLE IF EXISTS strategy_simulation_runs DROP COLUMN IF EXISTS root_state_id;
      DROP TABLE IF EXISTS strategy_move_outcomes CASCADE;
      DROP TABLE IF EXISTS strategy_states CASCADE;
    `);
    console.log("pre-deploy DB cleanup done");
  } catch (err: any) {
    console.warn("pre-deploy DB cleanup warning:", err.message);
  } finally {
    await pool.end();
  }
}

// Packages that are lazy-loaded via dynamic import in analyze.js (ML/embedding
// packages not needed for static analysis). Skipping them keeps the bundle small.
// analyze.js comment: "Embedding imports are lazy (dynamic import) so onnxruntime-node is never [loaded]"
// @huggingface/transformers and its full dep tree (onnxruntime-*) are all excluded.
// Do NOT add transitive deps of @huggingface/transformers here — they are never walked
// because the walker already stops at @huggingface/transformers.
const GITNEXUS_SKIP_DEPS = new Set([
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-common",
  "onnxruntime-web",
  "onnxruntime-react-native",
]);

const NON_LINUX_PREBUILTS = ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64", "linux-arm64"];

async function rmIfExists(path: string, opts: { recursive?: boolean } = {}) {
  await rm(path, { force: true, recursive: opts.recursive ?? false });
}

function readPkgDeps(dir: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    return Object.keys(pkg.dependencies || {});
  } catch {
    return [];
  }
}

/**
 * Walk gitnexus's full dep tree and return all packages that are hoisted to
 * root node_modules/ and must be explicitly copied into the runtime bundle.
 *
 * Resolution order for each dep mirrors Node.js module resolution:
 *   1. pkgDir/node_modules/<dep>  — nested in current package (included via parent copy)
 *   2. gitnexus/node_modules/<dep> — at the gitnexus level (included via gitnexus copy)
 *   3. root node_modules/<dep>     — hoisted to project root; must be explicitly copied
 *
 * Walking nested node_modules/ directories (step 1) is critical: packages like
 * cli-progress carry a nested string-width@4 whose deps (e.g. is-fullwidth-code-point)
 * are hoisted to root and would be missing without this traversal.
 *
 * GITNEXUS_SKIP_DEPS packages and optional deps not installed are silently skipped.
 */
function collectGitnexusHoistedDeps(gnDir: string): string[] {
  const gnNm = join(gnDir, "node_modules");
  const visitedDirs = new Set<string>();
  const hoistedNames = new Set<string>();
  const hoisted: string[] = [];

  function walkFromDir(pkgDir: string): void {
    if (visitedDirs.has(pkgDir)) return;
    visitedDirs.add(pkgDir);

    const deps = readPkgDeps(pkgDir);
    const localNm = join(pkgDir, "node_modules");

    for (const dep of deps) {
      if (GITNEXUS_SKIP_DEPS.has(dep)) continue;

      // 1. Nested inside the current package — included when we copy this package.
      //    Walk it anyway: its deps may have hoisted packages at root.
      const nestedInThis = join(localNm, dep);
      if (existsSync(nestedInThis)) {
        walkFromDir(nestedInThis);
        continue;
      }

      // 2. In gitnexus/node_modules/ — already bundled when we copy gitnexus.
      //    Walk it to discover any hoisted deps it pulls in transitively.
      const inGnNm = join(gnNm, dep);
      if (existsSync(inGnNm)) {
        walkFromDir(inGnNm);
        continue;
      }

      // 3. Hoisted to root node_modules/ — must be explicitly copied into the bundle.
      const rootPath = join("node_modules", dep);
      if (existsSync(rootPath)) {
        if (!hoistedNames.has(dep)) {
          hoistedNames.add(dep);
          hoisted.push(dep);
        }
        walkFromDir(rootPath);
        continue;
      }

      // Not found anywhere — optional dep not installed (tree-sitter-kotlin, etc.) — skip.
    }
  }

  walkFromDir(gnDir);
  return hoisted;
}

interface PatchSpec {
  file: string;
  find: string;
  replace: string;
  description: string;
  global?: boolean;
}

function buildGitnexusPatches(runtimeBase: string): PatchSpec[] {
  return [
    {
      file: `${runtimeBase}/dist/core/ingestion/workers/worker-pool.js`,
      find: "const SUB_BATCH_SIZE = 1500;",
      replace: "const SUB_BATCH_SIZE = 300;",
      description: "SUB_BATCH_SIZE 1500 → 300 (5× fewer ASTs per worker dispatch)",
    },
    {
      file: `${runtimeBase}/dist/core/ingestion/workers/worker-pool.js`,
      find: "const SUB_BATCH_TIMEOUT_MS = 30_000;",
      replace: "const SUB_BATCH_TIMEOUT_MS = 120_000;",
      description: "SUB_BATCH_TIMEOUT_MS 30 000 → 120 000 ms (worker gets time to finish small batches)",
    },
    {
      file: `${runtimeBase}/dist/core/ingestion/pipeline.js`,
      find: "const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20MB",
      replace: "const CHUNK_BYTE_BUDGET = 5 * 1024 * 1024; // 5MB (patched: reduce files-per-chunk for production)",
      description: "CHUNK_BYTE_BUDGET 20 MB → 5 MB (fewer files per pipeline chunk → fewer per worker dispatch)",
    },
    {
      file: `${runtimeBase}/dist/cli/analyze.js`,
      find: "        stopOnComplete: false,\n    }, cliProgress.Presets.shades_grey);",
      replace: "        stopOnComplete: false,\n        noTTYOutput: true,\n    }, cliProgress.Presets.shades_grey);",
      description: "analyze.js SingleBar: add noTTYOutput: true so cli-progress emits bar output when stdout is a pipe (non-TTY)",
    },
    // ── FTS connection-pool bug fix ────────────────────────────────────────────
    // Root cause of code_query returning empty results:
    //   initLbug() creates INITIAL_CONNS_PER_REPO=2 connections [conn0, conn1]
    //   and loads LOAD EXTENSION fts only on available[0] (conn0).
    //   checkout() uses available.pop() which always returns conn1 (the last element).
    //   conn0 is never used for FTS queries, so every CALL QUERY_FTS_INDEX
    //   runs on an unloaded session and silently returns [].
    // Fix: load FTS extension on every initial connection in the pool.
    {
      file: `${runtimeBase}/dist/mcp/core/lbug-adapter.js`,
      find: [
        "    // Load FTS extension once per shared Database",
        "    if (!shared.ftsLoaded) {",
        "        try {",
        "            await available[0].query('LOAD EXTENSION fts');",
        "            shared.ftsLoaded = true;",
        "        }",
        "        catch {",
        "            // Extension may not be installed — FTS queries will fail gracefully",
        "        }",
        "    }",
        "};",
      ].join("\n"),
      replace: [
        "    // Load FTS extension on EVERY initial connection in the pool.",
        "    // LOAD EXTENSION is per-session in LadybugDB: the original code loaded it only",
        "    // on available[0], but checkout() uses pop() which always returns available[1],",
        "    // so FTS queries silently returned [] on every search call.",
        "    if (!shared.ftsLoaded) {",
        "        let ftsOk = false;",
        "        for (const c of available) {",
        "            try {",
        "                await c.query('LOAD EXTENSION fts');",
        "                ftsOk = true;",
        "            }",
        "            catch {",
        "                // Extension may not be installed — FTS queries will fail gracefully",
        "            }",
        "        }",
        "        if (ftsOk) shared.ftsLoaded = true;",
        "    }",
        "};",
      ].join("\n"),
      description: "mcp/core/lbug-adapter.js: load FTS extension on ALL initial pool connections (not just available[0]) — fixes code_query BM25 returning empty results",
    },
    // ── Core lbug adapter FTS fix ─────────────────────────────────────────────
    // doInitLbug() creates a fresh connection without calling loadFTSExtension(),
    // so searchCode() / withLbugDb() calls (search_code tool) also silently fail.
    // Fix: best-effort LOAD EXTENSION fts immediately after the connection is created.
    {
      file: `${runtimeBase}/dist/core/lbug/lbug-adapter.js`,
      find: "    db = new lbug.Database(dbPath);\n    conn = new lbug.Connection(db);\n    for (const schemaQuery of SCHEMA_QUERIES) {",
      replace: "    db = new lbug.Database(dbPath);\n    conn = new lbug.Connection(db);\n    // Best-effort FTS load — needed for CALL QUERY_FTS_INDEX when reading an already-analyzed DB.\n    // loadFTSExtension() also checks ftsLoaded so it becomes a no-op after this succeeds.\n    try { await conn.query('LOAD EXTENSION fts'); ftsLoaded = true; } catch { /* best-effort */ }\n    for (const schemaQuery of SCHEMA_QUERIES) {",
      description: "core/lbug/lbug-adapter.js: load FTS extension in doInitLbug so withLbugDb/searchCode BM25 works",
    },
    // ── Fix labels(n)[0] KuzuDB syntax error ──────────────────────────────────
    // KuzuDB uses label(n) (singular) not Neo4j's labels(n)[0] (plural+index).
    // All 9 occurrences in the query tool cause type to be null on every result.
    {
      file: `${runtimeBase}/dist/mcp/local/local-backend.js`,
      find: "labels(n)[0]",
      replace: "label(n)",
      global: true,
      description: "mcp/local/local-backend.js: replace all labels(n)[0] with label(n) — KuzuDB uses singular label() not Neo4j's plural labels()[0]",
    },
    // ── FTS row-count diagnostic logging ──────────────────────────────────────
    // Add unconditional [gitnexus:fts:<Table>] rows: N logging so zero-result
    // FTS queries are visible in logs without needing to dig into DB state.
    {
      file: `${runtimeBase}/dist/core/search/bm25-index.js`,
      find: "        const rows = await executor(cypher);\n        return rows.map((row) => {",
      replace: "        const rows = await executor(cypher);\n        console.log(`[gitnexus:fts:${tableName}] rows: ${rows.length}`);\n        return rows.map((row) => {",
      description: "core/search/bm25-index.js: add unconditional FTS row-count logging for diagnostics",
    },
    // ── Fix pool growth path to load FTS on new connections ───────────────────
    // When the pool grows past INITIAL_CONNS_PER_REPO, checkout() calls
    // createConnection() but does NOT run LOAD EXTENSION fts on the new conn.
    // Result: all concurrently-created connections silently skip FTS.
    {
      file: `${runtimeBase}/dist/mcp/core/lbug-adapter.js`,
      find: "        entry.checkedOut++;\n        return Promise.resolve(createConnection(entry.db));",
      replace: "        entry.checkedOut++;\n        const _newConn = createConnection(entry.db);\n        return _newConn.query(\"LOAD EXTENSION fts\").catch(() => {}).then(() => _newConn);",
      description: "mcp/core/lbug-adapter.js: load FTS on pool-growth connections (checkout path) so new connections also support FTS queries",
    },
  ];
}

async function patchGitnexusRuntime(runtimeBase: string): Promise<void> {
  const patches = buildGitnexusPatches(runtimeBase);
  for (const patch of patches) {
    const original = await readFile(patch.file, "utf-8");
    if (!original.includes(patch.find)) {
      if (original.includes(patch.replace)) {
        console.log(`  [patch] already applied: ${patch.description}`);
        continue;
      }
      throw new Error(
        `patchGitnexusRuntime: stale patch — string not found in ${patch.file}\n` +
        `  Expected: ${patch.find}\n` +
        `  Gitnexus may have been updated; review and update the patch.`
      );
    }
    const patched = patch.global
      ? original.replaceAll(patch.find, patch.replace)
      : original.replace(patch.find, patch.replace);
    await writeFile(patch.file, patched, "utf-8");
    console.log(`  [patch] ${patch.description}`);
  }
  console.log("gitnexus runtime patches applied successfully");
}

/**
 * Stable cache key for the gitnexus runtime artifact: gitnexus package
 * version + sha256 of the patches block. When this key matches an entry in
 * the BuildKit cache mount (GITNEXUS_RUNTIME_CACHE_DIR), we restore the
 * cached `dist/gitnexus-runtime/` instead of re-copying / re-pruning /
 * re-patching from scratch.
 *
 * Hashing is stripped of `runtimeBase` (which depends on cwd) so the same
 * key works for every build that runs against the same gitnexus version
 * with the same patch block.
 */
function gitnexusCacheKey(): string {
  const gnPkg = JSON.parse(readFileSync("node_modules/gitnexus/package.json", "utf-8"));
  const patches = buildGitnexusPatches("__BASE__");
  const hash = createHash("sha256").update(JSON.stringify(patches)).digest("hex").slice(0, 16);
  return `${gnPkg.version}-${hash}`;
}

async function bundleGitnexusRuntime() {
  const runtimeBase = "dist/gitnexus-runtime/gitnexus";
  const runtimeNodeModules = `${runtimeBase}/node_modules`;
  const runtimeRoot = "dist/gitnexus-runtime";

  // ── Cache restore ────────────────────────────────────────────────────────
  // When GITNEXUS_RUNTIME_CACHE_DIR is set (BuildKit cache mount in the
  // Dockerfile), look up the cached artifact for the current
  // version+patches key. On hit, restore it and skip the rest of the
  // function. The cache dir is expected to persist across builds because
  // it's mounted as `--mount=type=cache,target=...`.
  const cacheDir = process.env.GITNEXUS_RUNTIME_CACHE_DIR;
  const cacheKey = cacheDir ? gitnexusCacheKey() : null;
  const cacheEntry = cacheDir && cacheKey ? join(cacheDir, cacheKey) : null;
  if (cacheEntry && existsSync(cacheEntry)) {
    console.log(`gitnexus runtime cache HIT (${cacheKey}) — restoring from ${cacheEntry}`);
    await mkdir(runtimeRoot, { recursive: true });
    await cp(cacheEntry, runtimeRoot, { recursive: true, errorOnExist: false });
    if (!existsSync(`${runtimeBase}/dist/cli/index.js`)) {
      throw new Error(`bundleGitnexusRuntime: cache restore from ${cacheEntry} produced no CLI entry`);
    }
    const totalKb = parseInt(execSync(`du -sk ${runtimeBase}`, { encoding: "utf-8" }).split("\t")[0], 10);
    console.log(`gitnexus runtime restored from cache (${(totalKb / 1024).toFixed(1)} MB)`);
    return;
  }
  if (cacheEntry) {
    console.log(`gitnexus runtime cache MISS (${cacheKey}) — building fresh`);
  }

  console.log("bundling gitnexus runtime for production...");

  await cp("node_modules/gitnexus", runtimeBase, {
    recursive: true,
    errorOnExist: false,
  });

  const hoisted = collectGitnexusHoistedDeps("node_modules/gitnexus");
  console.log(`  copying ${hoisted.length} hoisted packages into runtime bundle...`);

  for (const depName of hoisted) {
    const src = join("node_modules", depName);
    const dest = join(runtimeNodeModules, depName);

    await cp(src, dest, { recursive: true, errorOnExist: false });

    // ── @ladybugdb/core: strip heavy build-time artifacts ──────────────────────
    if (depName === "@ladybugdb/core") {
      // 407 MB C/C++ source — not needed at runtime
      await rmIfExists(`${dest}/lbug-source`, { recursive: true });
      // Build-time node_modules (cmake-js, node-addon-api, etc.) — not needed
      await rmIfExists(`${dest}/node_modules`, { recursive: true });
      // prebuilt/ is only used at install time (lbug_native.js loads top-level lbugjs.node)
      await rmIfExists(`${dest}/prebuilt`, { recursive: true });
    }

    // ── tree-sitter: strip non-linux prebuilts, src/, .wasm ────────────────────
    if (depName === "tree-sitter" || depName.startsWith("tree-sitter-")) {
      for (const platform of NON_LINUX_PREBUILTS) {
        await rmIfExists(`${dest}/prebuilds/${platform}`, { recursive: true });
      }
      await rmIfExists(`${dest}/src`, { recursive: true });
      try {
        const files = await readdir(dest);
        for (const f of files) {
          if (f.endsWith(".wasm")) await rmIfExists(`${dest}/${f}`);
        }
      } catch {}
      // Prune sub-language dirs (e.g. tree-sitter-typescript/typescript/, tsx/)
      try {
        const entries = await readdir(dest, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            await rmIfExists(`${dest}/${entry.name}/src`, { recursive: true });
          }
        }
      } catch {}
    }
  }

  // ── Memory-reduction patches ────────────────────────────────────────────────
  // Gitnexus ships with constants tuned for workstations (8 GB heap, 1500-file
  // sub-batches, 30 s per-sub-batch timeout). On the production GCE container
  // those settings cause OOM: the entire chunk of ~1445 files lands in one
  // worker postMessage → worker holds 1445 ASTs simultaneously → GC stalls →
  // 30 s timeout fires → sequential fallback runs IN the main server process
  // (worse for memory) → container OOM-kill.
  //
  // Patches applied to the COPIED runtime (never to node_modules/):
  //   worker-pool.js:  SUB_BATCH_SIZE  1500 → 300   (5× fewer ASTs per dispatch)
  //   worker-pool.js:  SUB_BATCH_TIMEOUT_MS  30 000 → 120 000  (worker gets time to finish)
  //   pipeline.js:     CHUNK_BYTE_BUDGET  20 MB → 5 MB  (fewer files per chunk → fewer per dispatch)
  //
  // Stale-patch guard: if gitnexus updates and the string is gone, the build
  // fails loudly rather than silently shipping unpatched code.
  await patchGitnexusRuntime(runtimeBase);

  // ── Post-bundle validation ──────────────────────────────────────────────────
  // 1. Verify the CLI entry point exists
  const cliEntry = `${runtimeBase}/dist/cli/index.js`;
  if (!existsSync(cliEntry)) {
    throw new Error(`bundleGitnexusRuntime: CLI entry not found at ${cliEntry}`);
  }
  // 2. Verify lbugjs.node (the runtime native binary) exists
  const lbugjsNode = `${runtimeNodeModules}/@ladybugdb/core/lbugjs.node`;
  if (!existsSync(lbugjsNode)) {
    throw new Error(`bundleGitnexusRuntime: missing lbugjs.node at ${lbugjsNode}`);
  }
  // 3. Ensure no forbidden non-linux prebuilt artifacts remain
  const forbiddenPatterns = ["darwin-arm64", "darwin-x64", "linux-arm64", "win32-x64"];
  const allNodeFiles = execSync(`find ${runtimeBase} -name "*.node" -type f`, { encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const nodeFile of allNodeFiles) {
    for (const bad of forbiddenPatterns) {
      if (nodeFile.includes(bad)) {
        throw new Error(`bundleGitnexusRuntime: forbidden non-linux artifact found: ${nodeFile}`);
      }
    }
  }
  // 4. Verify all required direct deps of gitnexus are present in the runtime bundle.
  //    This catches any dep that the walker failed to locate (missing install, etc.).
  //    We check runtimeNodeModules/<dep> — covers both nested-in-gitnexus and hoisted copies.
  const gnPkg = JSON.parse(readFileSync(join(runtimeBase, "package.json"), "utf-8"));
  const gnRequiredDeps = Object.keys(gnPkg.dependencies || {}).filter(
    (d) => !GITNEXUS_SKIP_DEPS.has(d)
  );
  const gnOptionalDeps = new Set(Object.keys(gnPkg.optionalDependencies || {}));
  const missingDeps: string[] = [];
  for (const dep of gnRequiredDeps) {
    if (gnOptionalDeps.has(dep)) continue;
    if (!existsSync(join(runtimeNodeModules, dep))) {
      missingDeps.push(dep);
    }
  }
  if (missingDeps.length > 0) {
    throw new Error(
      `bundleGitnexusRuntime: missing required runtime deps: ${missingDeps.join(", ")}`
    );
  }
  // 5. Ensure total bundle size is within threshold.
  //    Updated from 80 MB → 150 MB to account for the ~30 MB of hoisted JS deps
  //    (cli-progress, graphology, @modelcontextprotocol/sdk, zod, hono, etc.).
  //    The ML packages (@huggingface/transformers, onnxruntime-node) are excluded
  //    since analyze.js loads them lazily and they are not needed at runtime.
  const totalKb = parseInt(execSync(`du -sk ${runtimeBase}`, { encoding: "utf-8" }).split("\t")[0], 10);
  const totalMb = totalKb / 1024;
  const MAX_MB = 150;
  if (totalMb > MAX_MB) {
    throw new Error(`bundleGitnexusRuntime: runtime is ${totalMb.toFixed(1)}MB — exceeds ${MAX_MB}MB threshold`);
  }
  console.log(`gitnexus runtime bundled to dist/gitnexus-runtime/ (${totalMb.toFixed(1)} MB)`);

  // ── Cache save ───────────────────────────────────────────────────────────
  // Persist the freshly-built runtime into the BuildKit cache mount so the
  // next build with the same gitnexus version + patches reuses it. Saving
  // the parent dir (`dist/gitnexus-runtime/`) preserves the layout
  // expected by the cache-restore branch.
  if (cacheEntry) {
    try {
      await rm(cacheEntry, { recursive: true, force: true });
      await mkdir(cacheEntry, { recursive: true });
      await cp(runtimeRoot, cacheEntry, { recursive: true, errorOnExist: false });
      console.log(`gitnexus runtime cache SAVED (${cacheKey}) → ${cacheEntry}`);
    } catch (err) {
      console.warn(`gitnexus runtime cache save failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function bundleClaudeCliRuntime() {
  const src = "node_modules/@anthropic-ai/claude-code";
  if (!existsSync(src)) {
    console.warn("@anthropic-ai/claude-code not installed — skipping claude CLI bundle");
    return;
  }

  console.log("bundling claude CLI runtime for production...");

  const dest = "dist/claude-cli-runtime/node_modules/@anthropic-ai/claude-code";
  const binDir = "dist/claude-cli-runtime/node_modules/.bin";

  await cp(src, dest, { recursive: true, errorOnExist: false });
  await mkdir(binDir, { recursive: true });

  const binLink = join(binDir, "claude");
  try { await unlink(binLink); } catch {}
  await symlink("../@anthropic-ai/claude-code/cli.js", binLink);

  await chmod(join(dest, "cli.js"), 0o755);

  if (!existsSync(binLink)) {
    throw new Error("bundleClaudeCliRuntime: .bin/claude symlink not created");
  }

  const totalKb = parseInt(execSync(`du -sk dist/claude-cli-runtime`, { encoding: "utf-8" }).split("\t")[0], 10);
  const totalMb = totalKb / 1024;
  console.log(`claude CLI runtime bundled to dist/claude-cli-runtime/ (${totalMb.toFixed(1)} MB)`);
}

async function buildAll() {
  if (DEV_MODE) {
    console.log("BUILD_DEV_MODE=true — skipping GitHub push, DB cleanup, gitnexus runtime bundle, and claude CLI bundle.");
  }
  if (!DEV_MODE) {
    await pushToGitHub();
    await runDbCleanup();
  }
  await rm("dist", { recursive: true, force: true });

  // Railway/BuildKit layer reuse has previously served stale Vite client
  // bundles even when the deployment commit contained newer source. Vite keeps
  // pre-bundled dependency state under node_modules/.vite; wipe every known
  // cache location before the client build so the emitted asset hash reflects
  // the checked-out source, not a reused optimizer cache.
  console.log("clearing Vite build caches...");
  await rmIfExists("node_modules/.vite", { recursive: true });
  await rmIfExists("client/node_modules/.vite", { recursive: true });
  await rmIfExists(".vite", { recursive: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  // playwright-core lazily require()s chromium-bidi only for the BiDi transport
  // (used by firefox/webkit, not the chromium-over-CDP path we use). The package
  // isn't installed, so leave these as runtime requires that simply never fire.
  externals.push(
    "chromium-bidi/lib/cjs/bidiMapper/BidiMapper",
    "chromium-bidi/lib/cjs/cdp/CdpConnection",
  );

  const esmBanner = {
    js: "import { createRequire as __buildCreateRequire } from 'module'; import { fileURLToPath as __buildFileURLToPath } from 'url'; import { dirname as __buildDirname } from 'path'; const require = __buildCreateRequire(import.meta.url); const __filename = __buildFileURLToPath(import.meta.url); const __dirname = __buildDirname(__filename);",
  };

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "dist/index.mjs",
    banner: esmBanner,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
    plugins: [safeEsmHelperPlugin({ required: true })],
  });

  await esbuild({
    entryPoints: ["server/process-wrapper.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "dist/process-wrapper.mjs",
    banner: esmBanner,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
    plugins: [safeEsmHelperPlugin()],
  });

  // Heartbeat worker (Task #995) — emitted as a sibling artifact next to
  // dist/index.mjs so that `new Worker(path.join(here, "heartbeat-worker.mjs"))`
  // in the bundled main module finds it at runtime. Without this, production
  // boots without the canary and the wrapper has no fast liveness signal.
  await esbuild({
    entryPoints: ["server/heartbeat-worker.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "dist/heartbeat-worker.mjs",
    banner: esmBanner,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
    plugins: [safeEsmHelperPlugin()],
  });
  if (!existsSync("dist/heartbeat-worker.mjs")) {
    throw new Error("buildAll: dist/heartbeat-worker.mjs missing after esbuild — production canary will not start");
  }

  // Shell-index worker (Task #1007 step 7) — sibling artifact next to
  // dist/index.mjs, resolved by server/bridge-tools.ts the same way the
  // heartbeat worker is. One-shot worker spawned per oversize shell
  // call to do the CPU/string-heavy indexer prep work off the main
  // thread.
  await esbuild({
    entryPoints: ["server/shell-index-worker.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "dist/shell-index-worker.mjs",
    banner: esmBanner,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
    plugins: [safeEsmHelperPlugin()],
  });
  if (!existsSync("dist/shell-index-worker.mjs")) {
    throw new Error("buildAll: dist/shell-index-worker.mjs missing after esbuild — shell off-thread indexing will fall back to main");
  }

  if (!DEV_MODE) {
    await bundleGitnexusRuntime();
    await bundleClaudeCliRuntime();
  }
}

buildAll()
  .then(() => {
    // Some optional build paths can import runtime modules that initialize
    // timers or database pools. Exit explicitly so the build process cannot
    // hang after artifacts are complete.
    console.log("build complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
