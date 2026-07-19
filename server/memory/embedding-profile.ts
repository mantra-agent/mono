export const EMBEDDING_MODEL = "all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

export const MEMORY_VNEXT_EMBEDDING_PROFILE = {
  model: EMBEDDING_MODEL,
  dimensions: EMBEDDING_DIMENSIONS,
} as const;
