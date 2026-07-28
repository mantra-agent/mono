export { documentStorage, DocumentStorage } from "./document-storage";
export type { WorkspaceDocCompat } from "./document-storage";
export {
  cosineSimilarity,
  generateEmbedding,
  generateEmbeddings,
  isEmbeddingsAvailable,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
} from "./embedding";
export { evaluateLinks, parseLinkResults } from "./graph-discovery";
export type { EvaluatedLink } from "./graph-discovery";
export { searchVnextMemory } from "./vnext-search";
export type { VnextSearchOptions, VnextSearchResult, VnextSearchResponse } from "./vnext-search";
export { registerMemoryRoutes } from "./memory-routes";
export { registerMigrationRoutes } from "./migration-routes";
