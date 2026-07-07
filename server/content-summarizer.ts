export {
  persistToObjectStorage as persistOriginalContent,
  indexAndArchiveWithFallback as summarizeLargeContent,
  heuristicFallbackWithArchive as heuristicFallbackSummary,
} from "./content-indexer";

export type { IndexAndArchiveOptions as SummarizeOptions } from "./content-indexer";

export interface PersistOptions {
  content: string;
  category: string;
}
