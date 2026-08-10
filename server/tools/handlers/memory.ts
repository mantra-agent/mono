import { searchVnextMemory, type VnextSearchOptions } from "../../memory/vnext-search";
import type { ToolHandler } from "../contracts";

/**
 * Memory handlers extracted from bridge-tools.ts. These are the model-visible
 * document read/write surface plus vNEXT claim read/search. Behavior, result
 * shapes, and error handling are preserved verbatim; public identity
 * (tool-registry), ownership/composition (domain-adapters), and the executeTool
 * invocation/authority boundary remain owned by their canonical modules. The
 * retired-legacy-action guard stays in bridge-tools because it is owned by the
 * `memory`/`memory_ops` umbrella dispatchers, not this map.
 */
export const memoryTools: Record<string, ToolHandler> = {
  async memory_read(args) {
    const file = args.file;
    if (!file) return { result: "Missing file name. Available: PRINCIPLES.md, or any workspace file. Identity and user context are in your context spine.", error: true };

    try {
      const { documentStorage } = await import("../../memory/document-storage");

      const baseName = file.replace(/^\/+/, "");
      const isIdentity = /^(SOUL|USER|PRINCIPLES|TOOLS|SKILL|AGENTS)\.md$/i.test(baseName);

      if (isIdentity) {
        const docId = baseName.replace(/\.md$/i, "").toLowerCase();
        const doc = await documentStorage.getDocument("identity", docId);
        if (doc) return { result: doc.content };
      }

      const docByPath = await documentStorage.getDocumentByPath(baseName);
      if (docByPath) return { result: docByPath.content };

      const parts = baseName.split("/");
      if (parts.length >= 2) {
        const docType = parts[0].replace(/s$/, "");
        const docId = parts.slice(1).join("/").replace(/\.(md|json|yaml)$/, "");
        const doc = await documentStorage.getDocument(docType, docId);
        if (doc) return { result: doc.content };
      }

      return { result: `File not found in workspace: ${file}`, error: true };
    } catch (err: any) {
      return { result: `Error reading ${file}: ${err.message}`, error: true };
    }
  },

  async memory_write(args) {
    const file = args.file;
    if (!file) return { result: "Missing file name", error: true };

    const content = args.content;
    if (content === undefined || content === null) return { result: "Missing content", error: true };

    try {
      const { documentStorage } = await import("../../memory/document-storage");

      const baseName = file.replace(/^\/+/, "");
      const isIdentity = /^(SOUL|USER|PRINCIPLES|TOOLS|SKILL|AGENTS)\.md$/i.test(baseName);
      const docType = isIdentity ? "identity" : "file";
      const docId = baseName;

      if (args.append) {
        const existing = await documentStorage.getDocumentByPath(baseName);
        if (existing) {
          const merged = existing.content + "\n" + content;
          await documentStorage.upsertDocument(docType, docId, baseName, baseName, merged, {});
          return { result: `Appended to ${file}` };
        }
      }

      await documentStorage.upsertDocument(docType, docId, baseName, baseName, content, {});
      return { result: `Written to ${file} (${content.length} bytes)` };
    } catch (err: any) {
      return { result: `Error writing ${file}: ${err.message}`, error: true };
    }
  },

  async memory_read_entry(args) {
    const id = typeof args.id === "number" ? args.id : parseInt(args.id, 10);
    if (isNaN(id)) return { result: "Missing or invalid vNEXT claim ID. Provide a numeric ID from memory.search results.", error: true };

    try {
      const { memoryVnextClaimStorage } = await import("../../memory/vnext-claim-storage");
      const detail = await memoryVnextClaimStorage.getClaimDetail(id);
      if (!detail) return { result: `vNEXT claim #${id} not found`, error: true };
      await Promise.all([
        memoryVnextClaimStorage.reinforceClaim(id),
        memoryVnextClaimStorage.touchClaim(id),
      ]);
      const claim = detail.claim;
      const metadata = [
        `ID: ${claim.id}`,
        `Storage: memory_vnext_claims`,
        `Lifecycle: ${claim.lifecycleStage}`,
        `Claim type: ${claim.claimType}`,
        `Confidence: ${claim.confidence.toFixed(2)}`,
        `Source: ${claim.source}`,
        claim.sourceId ? `Source ID: ${claim.sourceId}` : "",
        claim.title ? `Title: ${claim.title}` : "",
        `Created: ${claim.createdAt.toISOString().slice(0, 16)}`,
        claim.topics?.length ? `Topics: ${claim.topics.join(", ")}` : "",
      ].filter(Boolean).join("\n");
      const sources = detail.sources.length > 0
        ? `\n\nSources:\n${detail.sources.map((source) => `- ${source.sourceType}/${source.sourceId} (${source.relationship}, strength ${source.strength.toFixed(2)})${source.quote ? `: ${source.quote}` : ""}`).join("\n")}`
        : "";
      const links = detail.claimLinks.length > 0
        ? `\n\nClaim links:\n${detail.claimLinks.map((link) => `- #${link.fromClaimId === id ? link.toClaimId : link.fromClaimId} (${link.relationship}, strength ${link.strength.toFixed(2)})`).join("\n")}`
        : "";
      return { result: `${metadata}\n\n--- Claim ---\n${claim.content}${sources}${links}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: `Error reading vNEXT claim #${id}: ${message}`, error: true };
    }
  },

  async memory_search(args) {
    const query = args.query;
    if (!query || typeof query !== "string") return { result: "Missing query string", error: true };

    try {
      const unsupported = [
        ["layer", args.layer],
        ["integrationStage", args.integrationStage],
        ["hasSummary", args.hasSummary],
        ["hasDeletionScheduled", args.hasDeletionScheduled],
        ["deletionExpired", args.deletionExpired],
      ].filter(([, value]) => value !== undefined).map(([name]) => name);
      if (unsupported.length > 0) {
        return { result: `Legacy-only memory.search filters are retired: ${unsupported.join(", ")}. Search vNEXT claims with source, dates, links, recall count, title, lifecycle, and content length filters.`, error: true };
      }
      const options: VnextSearchOptions = {
        query,
        limit: typeof args.limit === "number" ? Math.min(args.limit, 100) : 20,
        offset: typeof args.offset === "number" ? Math.max(args.offset, 0) : 0,
        source: typeof args.source === "string" ? args.source : undefined,
        claimType: typeof args.claimType === "string" ? args.claimType : undefined,
        lifecycleStage: typeof args.lifecycleStage === "string" ? args.lifecycleStage : undefined,
        startDate: typeof args.startDate === "string" ? args.startDate : undefined,
        endDate: typeof args.endDate === "string" ? args.endDate : undefined,
        timezone: typeof args.timezone === "string" ? args.timezone : undefined,
        minLinks: args.minLinks !== undefined ? Number(args.minLinks) : undefined,
        maxLinks: args.maxLinks !== undefined ? Number(args.maxLinks) : undefined,
        minContentLength: args.minContentLength !== undefined ? Number(args.minContentLength) : undefined,
        maxContentLength: args.maxContentLength !== undefined ? Number(args.maxContentLength) : undefined,
        recalledBefore: typeof args.recalledBefore === "string" ? args.recalledBefore : undefined,
        recalledAfter: typeof args.recalledAfter === "string" ? args.recalledAfter : undefined,
        minRecallCount: args.minRecallCount !== undefined ? Number(args.minRecallCount) : undefined,
        maxRecallCount: args.maxRecallCount !== undefined ? Number(args.maxRecallCount) : undefined,
        hasTitle: args.hasTitle !== undefined ? Boolean(args.hasTitle) : undefined,
        createdBefore: typeof args.createdBefore === "string" ? args.createdBefore : undefined,
        createdAfter: typeof args.createdAfter === "string" ? args.createdAfter : undefined,
        updatedBefore: typeof args.updatedBefore === "string" ? args.updatedBefore : undefined,
        updatedAfter: typeof args.updatedAfter === "string" ? args.updatedAfter : undefined,
        sortBy: ["createdAt", "contentLength", "linkCount", "recallCount"].includes(String(args.sortBy))
          ? args.sortBy as VnextSearchOptions["sortBy"]
          : undefined,
        sortOrder: args.sortOrder === "asc" || args.sortOrder === "desc" ? args.sortOrder : undefined,
      };
      const response = await searchVnextMemory(options);
      if (response.results.length === 0) return { result: `No vNEXT claims found for "${query}"` };

      const formatted = response.results.map((result, index) => {
        const claim = result.claim;
        const meta = [
          `id=${claim.id}`,
          `storage=vnext`,
          `stage=${claim.lifecycleStage}`,
          `type=${claim.claimType}`,
          `source=${claim.source}`,
          `score=${result.score.toFixed(3)}`,
          `emb=${result.embeddingSimilarity.toFixed(3)}`,
          `links=${result.linkCount}`,
          `recalls=${claim.recallCount}`,
        ];
        const date = claim.createdAt ? new Date(claim.createdAt).toISOString().slice(0, 16) : "";
        const title = claim.title ? `"${claim.title}"` : "";
        const preview = claim.content.length > 500 ? `${claim.content.slice(0, 500)}...` : claim.content;
        return `[${index + 1}] (${meta.join(", ")}) ${date} ${title}\n${preview}`;
      }).join("\n\n");
      return { result: `Found ${response.results.length} vNEXT claims for "${query}". Use memory.vnext_claim_detail(id) for full provenance and graph details.\n\n${formatted}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: `vNEXT search error: ${message}`, error: true };
    }
  },
};
