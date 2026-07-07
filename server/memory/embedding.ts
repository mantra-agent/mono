import { createHash } from "crypto";
import { trackEmbedding } from "../cost-tracker";
import { ACTIVITY_MEMORY } from "../job-profiles";
import { createLogger } from "../log";

const log = createLogger("Embedding");

const EMBEDDING_MODEL = "all-MiniLM-L6-v2";
const EMBEDDING_DIMENSIONS = 384;

const EMBEDDING_CACHE_MAX_SIZE = 200;
const _embeddingCache = new Map<string, { vector: number[]; timestamp: number }>();

let _pipeline: any = null;
let _pipelineLoading: Promise<any> | null = null;

function getTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function getCachedEmbedding(text: string): number[] | null {
  const hash = getTextHash(text);
  const entry = _embeddingCache.get(hash);
  if (entry) {
    log.log(`Embedding cache hit for hash=${hash.slice(0, 8)} (age=${Date.now() - entry.timestamp}ms)`);
    return entry.vector;
  }
  return null;
}

function setCachedEmbedding(text: string, vector: number[]): void {
  if (_embeddingCache.size >= EMBEDDING_CACHE_MAX_SIZE) {
    const oldestKey = _embeddingCache.keys().next().value;
    if (oldestKey) _embeddingCache.delete(oldestKey);
  }
  const hash = getTextHash(text);
  _embeddingCache.set(hash, { vector, timestamp: Date.now() });
}

async function getPipeline(): Promise<any> {
  if (_pipeline) return _pipeline;
  if (_pipelineLoading) return _pipelineLoading;

  _pipelineLoading = (async () => {
    log.log(`Loading local embedding model: Xenova/${EMBEDDING_MODEL} (~80MB on first download)...`);
    const startTime = Date.now();
    const { pipeline } = await import("@huggingface/transformers");
    const pipe = await pipeline("feature-extraction", `Xenova/${EMBEDDING_MODEL}`, {
      dtype: "fp32",
    });
    log.log(`Local embedding model loaded in ${Date.now() - startTime}ms`);
    _pipeline = pipe;
    _pipelineLoading = null;
    return pipe;
  })();

  return _pipelineLoading;
}

export function isEmbeddingsAvailable(): boolean {
  return true;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const trimmed = text.trim();
  if (!trimmed) {
    return new Array(EMBEDDING_DIMENSIONS).fill(0);
  }

  const cached = getCachedEmbedding(trimmed);
  if (cached) return cached;

  const pipe = await getPipeline();
  const startTime = Date.now();

  log.log(`Generating local embedding, model=${EMBEDDING_MODEL}, input length=${trimmed.length}`);
  const output = await pipe(trimmed, { pooling: "mean", normalize: true });
  const embedding = Array.from(output.data as Float32Array) as number[];

  log.log(`Local embedding generated in ${Date.now() - startTime}ms, dimensions=${embedding.length}`);

  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Unexpected embedding dimensions: got ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}`);
  }

  // Track for observability (zero cost)
  trackEmbedding({ tokenCount: 0, startTime, profile: "embedding", batchSize: 1, texts: [trimmed] });

  setCachedEmbedding(trimmed, embedding);
  return embedding;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const pipe = await getPipeline();
  const results: number[][] = new Array(texts.length);

  log.log(`generateEmbeddings totalTexts=${texts.length} (sequential local processing)`);

  for (let i = 0; i < texts.length; i++) {
    const trimmed = texts[i].trim();
    if (!trimmed) {
      results[i] = new Array(EMBEDDING_DIMENSIONS).fill(0);
      continue;
    }

    const cached = getCachedEmbedding(trimmed);
    if (cached) {
      results[i] = cached;
      continue;
    }

    const startTime = Date.now();
    const output = await pipe(trimmed, { pooling: "mean", normalize: true });
    const embedding = Array.from(output.data as Float32Array) as number[];

    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Unexpected embedding dimensions: got ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}`);
    }

    setCachedEmbedding(trimmed, embedding);
    results[i] = embedding;

    // Log progress for large batches
    if (texts.length > 10 && (i + 1) % 50 === 0) {
      log.log(`embeddings progress: ${i + 1}/${texts.length} (${Date.now() - startTime}ms for last item)`);
    }
  }

  // Track batch for observability (zero cost)
  trackEmbedding({ tokenCount: 0, startTime: Date.now(), profile: ACTIVITY_MEMORY, batchSize: texts.length, texts });

  return results;
}

export { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL };
