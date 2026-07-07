// Shell indexer worker (Task #1007 step 7).
//
// One-shot worker thread spawned by the shell tool when stdout exceeds the
// indexer threshold. Its only job is to do the CPU/string-heavy work that
// would otherwise pin the main thread:
//   1. Read the shell-output temp file from disk.
//   2. Trim it (string allocation on potentially many MB).
//   3. Compute byteCount via Buffer.byteLength.
//   4. Slice the head chunk for LLM-based indexing (~80KB).
//
// The full content NEVER crosses back to main: we post a small payload
// {byteCount, headChunk, totalChars}. Object storage upload happens on the
// main thread by streaming the temp file from disk (createReadStream →
// file.createWriteStream), so main-thread heap stays bounded regardless
// of stdout size.
//
// Network/DB I/O (LLM call, DB insert, object storage upload) intentionally
// stay on main — they would require re-bootstrapping pg pool / OpenAI / S3
// clients in the worker for every call, which is wasteful for one-shot
// workers and worse for the connection pool than just doing it on main.
//
// The worker exits as soon as it posts its result so the parent's worker
// .on("exit") handler resolves the promise.

import { parentPort, workerData } from "worker_threads";
import { readFile } from "fs/promises";

interface WorkerInput {
  filePath: string;
  indexChunkSize: number;
}

interface WorkerSuccess {
  ok: true;
  byteCount: number;
  headChunk: string;
  totalChars: number;
}

interface WorkerFailure {
  ok: false;
  error: string;
}

type WorkerResult = WorkerSuccess | WorkerFailure;

async function run(): Promise<WorkerResult> {
  const { filePath, indexChunkSize } = workerData as WorkerInput;
  if (!filePath) return { ok: false, error: "missing filePath" };
  if (!Number.isFinite(indexChunkSize) || indexChunkSize <= 0) {
    return { ok: false, error: "invalid indexChunkSize" };
  }

  try {
    const buf = await readFile(filePath);
    // byteCount must reflect what is actually archived to object storage
    // (the raw file, streamed by the indexer on the main thread). The
    // trimmed string is a derived view used only for LLM-facing
    // metadata (headChunk + totalChars), not for storage accounting.
    const byteCount = buf.byteLength;
    // .trim() on the full string is the heaviest CPU op here for multi-MB
    // input — keep it inside the worker so main never blocks on it.
    const text = buf.toString("utf-8").trim();
    const totalChars = text.length;
    const headChunk = text.length > indexChunkSize ? text.slice(0, indexChunkSize) : text;
    return { ok: true, byteCount, headChunk, totalChars };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

if (parentPort) {
  run()
    .then((result) => parentPort!.postMessage(result))
    .catch((err) => parentPort!.postMessage({ ok: false, error: String(err?.message || err) } satisfies WorkerFailure))
    .finally(() => {
      // Explicit exit so the parent's worker.on("exit") fires deterministically.
      // The parent uses worker.once("message") to collect the result, then
      // awaits exit before resolving — without this, the worker's libuv loop
      // could keep it alive briefly waiting for nothing.
      process.nextTick(() => process.exit(0));
    });
}
