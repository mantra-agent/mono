import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import { generateEmbeddings, generateEmbedding, isEmbeddingsAvailable, EMBEDDING_DIMENSIONS } from "./memory/embedding";

const log = createLogger("CodeEmbed");

type EmbeddingStatus = "idle" | "embedding" | "ready" | "error";

let _status: EmbeddingStatus = "idle";
let _lastError: string | null = null;
let _totalSymbols = 0;
let _embeddedCount = 0;
let _lastEmbeddedAt: string | null = null;

const UPSERT_BATCH_SIZE = 50;
const MAX_CONTENT_LENGTH = 8000;

interface SymbolNode {
  name: string;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

interface SemanticResult {
  id: number;
  symbolName: string;
  symbolType: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  similarity: number;
  content: string;
}

function contentHash(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

async function readSourceLines(filePath: string, startLine: number, endLine: number): Promise<string | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    const snippet = lines.slice(start, end).join("\n");
    if (snippet.length > MAX_CONTENT_LENGTH) {
      return snippet.slice(0, MAX_CONTENT_LENGTH);
    }
    return snippet;
  } catch {
    return null;
  }
}

async function extractSymbolsFromGraph(): Promise<SymbolNode[]> {
  const { callTool } = await import("./gitnexus-bridge");

  const types = ["Function", "Class", "Method", "Interface"];
  const symbols: SymbolNode[] = [];

  for (const type of types) {
    try {
      const cypher = `MATCH (n:${type}) WHERE n.filePath IS NOT NULL AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL RETURN n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine LIMIT 5000`;
      const raw = await callTool("cypher", { query: cypher });
      const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);

      let parsed: any;
      try {
        parsed = JSON.parse(rawStr);
      } catch {
        log.warn(`[CodeEmbed] Failed to parse ${type} cypher result`);
        continue;
      }

      let rows: Record<string, string>[] = [];
      if (Array.isArray(parsed)) {
        rows = parsed;
      } else if (parsed && typeof parsed.markdown === "string") {
        const lines = parsed.markdown.split("\n").map((l: string) => l.trim()).filter((l: string) => l);
        if (lines.length >= 3) {
          const headers = lines[0].split("|").map((h: string) => h.trim()).filter((h: string) => h);
          for (let i = 2; i < lines.length; i++) {
            const cells = lines[i].split("|").map((c: string) => c.trim());
            const valueCells = cells.filter((_: string, idx: number) => idx > 0 && idx <= headers.length);
            const row: Record<string, string> = {};
            headers.forEach((h: string, idx: number) => { row[h] = valueCells[idx] ?? ""; });
            rows.push(row);
          }
        }
      }

      for (const row of rows) {
        const name = row.name || "";
        const filePath = row.filePath || "";
        const startLine = parseInt(row.startLine || "0", 10);
        const endLine = parseInt(row.endLine || "0", 10);
        if (name && filePath && startLine > 0 && endLine > 0) {
          symbols.push({ name, type, filePath, startLine, endLine });
        }
      }

      log.debug(`[CodeEmbed] Extracted ${rows.length} ${type} nodes from graph`);
    } catch (err) {
      log.warn(`[CodeEmbed] Failed to extract ${type} nodes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.debug(`[CodeEmbed] Total symbols extracted: ${symbols.length}`);
  return symbols;
}

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS code_embeddings (
      id SERIAL PRIMARY KEY,
      symbol_name TEXT NOT NULL,
      symbol_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      content_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding vector(384),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_code_embed_type_name_path UNIQUE (symbol_type, symbol_name, file_path)
    )
  `);
  await db.execute(sql`ALTER TABLE code_embeddings ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_code_embed_file ON code_embeddings(file_path)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_code_embed_type ON code_embeddings(symbol_type)`);
}

export async function embedCodeSymbols(): Promise<void> {
  if (!isEmbeddingsAvailable()) {
    log.warn("[CodeEmbed] Embeddings not available (no API key). Skipping code embedding.");
    _status = "error";
    _lastError = "No OpenAI API key configured";
    return;
  }

  _status = "embedding";
  _lastError = null;
  const startMs = Date.now();

  try {
    await ensureTable();
    log.debug("[CodeEmbed] Table ensured, extracting symbols from graph...");

    const symbols = await extractSymbolsFromGraph();
    _totalSymbols = symbols.length;

    if (symbols.length === 0) {
      log.debug("[CodeEmbed] No symbols found in graph. Nothing to embed.");
      _status = "ready";
      _embeddedCount = 0;
      _lastEmbeddedAt = new Date().toISOString();
      return;
    }

    const existingRows = await db.execute(sql`
      SELECT symbol_type, symbol_name, file_path, content_hash FROM code_embeddings
    `);
    const existingMap = new Map<string, string>();
    for (const row of existingRows.rows as any[]) {
      const key = `${row.symbol_type}:${row.symbol_name}:${row.file_path}`;
      existingMap.set(key, row.content_hash);
    }

    const toEmbed: Array<{ symbol: SymbolNode; content: string; hash: string }> = [];
    let skipped = 0;

    for (const symbol of symbols) {
      const source = await readSourceLines(symbol.filePath, symbol.startLine, symbol.endLine);
      if (!source || !source.trim()) {
        skipped++;
        continue;
      }

      const hash = contentHash(source);
      const key = `${symbol.type}:${symbol.name}:${symbol.filePath}`;
      if (existingMap.has(key) && existingMap.get(key) === hash) {
        skipped++;
        existingMap.delete(key);
        continue;
      }
      existingMap.delete(key);

      toEmbed.push({ symbol, content: source, hash });
    }

    log.debug(`[CodeEmbed] To embed: ${toEmbed.length}, skipped (unchanged): ${skipped}, stale to remove: ${existingMap.size}`);

    if (existingMap.size > 0) {
      for (const key of existingMap.keys()) {
        const [sType, sName, ...fpParts] = key.split(":");
        const fp = fpParts.join(":");
        try {
          await db.execute(sql`
            DELETE FROM code_embeddings
            WHERE symbol_type = ${sType} AND symbol_name = ${sName} AND file_path = ${fp}
          `);
        } catch (err) {
          log.warn(`[CodeEmbed] Failed to delete stale entry ${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      log.debug(`[CodeEmbed] Deleted ${existingMap.size} stale entries`);
    }

    if (toEmbed.length === 0) {
      log.debug("[CodeEmbed] No new/changed symbols to embed.");
      _status = "ready";
      _embeddedCount = _totalSymbols - skipped;
      _lastEmbeddedAt = new Date().toISOString();
      return;
    }

    let embedded = 0;
    for (let i = 0; i < toEmbed.length; i += UPSERT_BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + UPSERT_BATCH_SIZE);
      const texts = batch.map(b => `${b.symbol.type} ${b.symbol.name} in ${b.symbol.filePath}:\n${b.content}`);

      try {
        const embeddings = await generateEmbeddings(texts);

        for (let j = 0; j < batch.length; j++) {
          const { symbol, content, hash } = batch[j];
          const embeddingStr = `[${embeddings[j].join(",")}]`;
          try {
            await db.execute(sql`
              INSERT INTO code_embeddings (symbol_name, symbol_type, file_path, start_line, end_line, content_hash, content, embedding, created_at, updated_at)
              VALUES (${symbol.name}, ${symbol.type}, ${symbol.filePath}, ${symbol.startLine}, ${symbol.endLine}, ${hash}, ${content}, ${embeddingStr}::vector, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
              ON CONFLICT ON CONSTRAINT uq_code_embed_type_name_path
              DO UPDATE SET content_hash = ${hash}, content = ${content}, embedding = ${embeddingStr}::vector,
                start_line = ${symbol.startLine}, end_line = ${symbol.endLine}, updated_at = CURRENT_TIMESTAMP
            `);
            embedded++;
          } catch (err) {
            log.warn(`[CodeEmbed] Failed to upsert ${symbol.type}:${symbol.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        log.debug(`[CodeEmbed] Batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}/${Math.ceil(toEmbed.length / UPSERT_BATCH_SIZE)} complete, embedded=${embedded}`);
      } catch (err) {
        log.warn(`[CodeEmbed] Batch embedding failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    _embeddedCount = embedded + (_totalSymbols - toEmbed.length - skipped) + skipped;
    _lastEmbeddedAt = new Date().toISOString();
    _status = "ready";
    log.debug(`[CodeEmbed] Embedding complete: ${embedded} new/updated, ${skipped} unchanged, total=${_totalSymbols}, elapsed=${Date.now() - startMs}ms`);

  } catch (err) {
    _status = "error";
    _lastError = err instanceof Error ? err.message : String(err);
    log.error(`[CodeEmbed] embedCodeSymbols failed: ${_lastError}`);
  }
}

export async function searchCodeSemantic(query: string, limit = 10): Promise<SemanticResult[]> {
  if (_status !== "ready") {
    log.debug(`[CodeEmbed] Semantic search skipped, status=${_status}`);
    return [];
  }

  if (!isEmbeddingsAvailable()) return [];

  try {
    const startMs = Date.now();
    const queryEmbedding = await generateEmbedding(query);
    const embeddingStr = `[${queryEmbedding.join(",")}]`;

    const results = await db.execute(sql`
      SELECT id, symbol_name, symbol_type, file_path, start_line, end_line, content,
        1 - (embedding <=> ${embeddingStr}::vector) AS similarity
      FROM code_embeddings
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `);

    const rows = (results.rows as any[]).map(row => ({
      id: row.id,
      symbolName: row.symbol_name,
      symbolType: row.symbol_type,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      similarity: parseFloat(String(row.similarity ?? "0")),
      content: row.content,
    }));

    log.debug(`[CodeEmbed] Semantic search query="${query}" results=${rows.length} top_similarity=${rows[0]?.similarity?.toFixed(4) ?? "N/A"} elapsed=${Date.now() - startMs}ms`);
    return rows;
  } catch (err) {
    log.warn(`[CodeEmbed] Semantic search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function getEmbeddingStatus(): {
  status: EmbeddingStatus;
  totalSymbols: number;
  embeddedCount: number;
  lastEmbeddedAt: string | null;
  lastError: string | null;
} {
  return {
    status: _status,
    totalSymbols: _totalSymbols,
    embeddedCount: _embeddedCount,
    lastEmbeddedAt: _lastEmbeddedAt,
    lastError: _lastError,
  };
}

export function initCodeEmbeddingListener(): void {
  const listenerRegisteredAt = Date.now();
  import("./event-bus").then(({ eventBus }) => {
    eventBus.on("event", (busEvent: any) => {
      if (busEvent.event === "system:nexus_ready") {
        const initElapsed = busEvent.payload?.elapsed ?? "unknown";
        const listenerAgeSec = Math.round((Date.now() - listenerRegisteredAt) / 1000);
        log.debug(`[CodeEmbed] nexus_ready received (initElapsed=${initElapsed}ms, listenerAge=${listenerAgeSec}s), starting background embedding...`);
        embedCodeSymbols().catch(err => {
          log.error(`[CodeEmbed] Background embedding failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    });
    log.debug("[CodeEmbed] Registered nexus_ready listener for code embedding");

    // If backend is already ready (event fired before listener attached), start immediately
    import("./gitnexus-bridge").then(({ isGitNexusReady }) => {
      if (isGitNexusReady() && _status === "idle") {
        log.debug("[CodeEmbed] Backend already ready at listener init time, starting embedding immediately...");
        embedCodeSymbols().catch(err => {
          log.error(`[CodeEmbed] Immediate embedding failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }).catch(() => {});
  }).catch(err => {
    log.warn(`[CodeEmbed] Failed to register event listener: ${err instanceof Error ? err.message : String(err)}`);
  });
}
