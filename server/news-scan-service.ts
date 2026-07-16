import { db as database } from "./db";
import { createLogger } from "./log";
import { signalStorage } from "./news-storage";
import { thesisStorage } from "./thesis-storage";
import { getSetting, setSetting } from "./system-settings";
import { execSkills } from "@shared/schema";
import { eq, or } from "drizzle-orm";
import * as adapters from "./news-adapters";
import * as ranking from "./news-ranking";
import { executeAutonomousSkillRun } from "./autonomous-skill-runner";
import { getCurrentPrincipal, runWithPrincipal } from "./principal-context";
import { createUserSessionPrincipal } from "./principal";
import { storage } from "./storage";
import { SourceDiagnosticsAccumulator, gateRawSignals } from "./news-quality";

const log = createLogger("LandscapeScanService");

export type LandscapeScanOutcome = "completed" | "already_running" | "failed";

export interface LandscapeScanResult {
  outcome: LandscapeScanOutcome;
  sourcesScanned: number;
  itemsFound: number;
  itemsSurfaced: number;
  itemsDeduped: number;
  errors: string[];
  message: string;
}

async function loadDomainSkillNames(): Promise<string[]> {
  try {
    const skills = await database.select({ name: execSkills.name, skillType: execSkills.skillType })
      .from(execSkills)
      .where(or(eq(execSkills.skillType, "applied"), eq(execSkills.skillType, "domain")));
    return skills.map(s => s.name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`scan: skill context unavailable (${msg})`);
    return [];
  }
}

async function resolveNewsScanPrincipal() {
  const users = await storage.getUsers();
  const user = users.find(candidate => candidate.role === "admin") ?? users[0];
  if (!user) {
    throw new Error("News scan requires an owning user principal");
  }
  return createUserSessionPrincipal(user);
}

export async function runLandscapeScan(): Promise<LandscapeScanResult> {
  if (!getCurrentPrincipal()) {
    const principal = await resolveNewsScanPrincipal();
    return runWithPrincipal(principal, runLandscapeScan);
  }

  const inProgress = await signalStorage.hasInProgressScan();
  if (inProgress) {
    return {
      outcome: "already_running",
      sourcesScanned: 0,
      itemsFound: 0,
      itemsSurfaced: 0,
      itemsDeduped: 0,
      errors: [],
      message: "A scan is already in progress. Try again later.",
    };
  }

  const scanRun = await signalStorage.startScanRun();
  const scanStartedAt = scanRun.startedAt ?? new Date();
  const diagnostics = new SourceDiagnosticsAccumulator(scanRun.id);

  try {
    await signalStorage.migrateChannelsAndTopics();
    const invalidXArticleLinksArchived = await signalStorage.archiveInvalidXArticleLinks();
    if (invalidXArticleLinksArchived > 0) {
      log.log(`scan: archived ${invalidXArticleLinksArchived} invalid X/Grok Story links before ranking`);
    }

    const allSources = await signalStorage.listSources();
    const enabledSources = allSources.filter(s => s.enabled);

    const hasChannels = enabledSources.some(s => s.sourceType === "channel_x" || s.sourceType === "channel_web");
    const hasDirectSources = enabledSources.some(s => !s.sourceType.startsWith("channel_") && s.sourceType !== "pinned_topic");
    if (!hasChannels && !hasDirectSources) {
      await signalStorage.completeScanRun(scanRun.id, {
        sourcesScanned: 0,
        itemsFound: 0,
        itemsSurfaced: 0,
        itemsDeduped: 0,
        error: "No enabled channels or sources configured",
      });
      return {
        outcome: "failed",
        sourcesScanned: 0,
        itemsFound: 0,
        itemsSurfaced: 0,
        itemsDeduped: 0,
        errors: ["No enabled channels or sources configured"],
        message: "No enabled channels or sources configured. Enable channels on the Channels tab or add direct sources.",
      };
    }

    const interestGraph = await adapters.buildInterestGraph();
    const searchTopics = interestGraph.length >= 3
      ? interestGraph
      : [...interestGraph, ...adapters.DEFAULT_TOPICS.map(t => ({ tag: t, weight: 0.3, source: "pinned" as const, sourceRef: "" }))];

    const queries = adapters.generateSearchQueries(searchTopics, ranking.LANDSCAPE_SCAN_BUDGET.maxSearchQueries);
    const discoveryQueries = adapters.generateDiscoveryQueries(searchTopics, ranking.LANDSCAPE_SCAN_BUDGET.maxDiscoveryQueries);

    const channelX = enabledSources.find(s => s.sourceType === "channel_x");
    const channelWeb = enabledSources.find(s => s.sourceType === "channel_web");
    const subreddits = enabledSources.filter(s => s.sourceType === "subreddit");
    const rssFeeds = enabledSources.filter(s => s.sourceType === "rss_feed");
    const xAccounts = enabledSources.filter(s => s.sourceType === "x_account");
    const hnSources = enabledSources.filter(s => s.sourceType === "hackernews");
    const githubRepos = enabledSources.filter(s => s.sourceType === "github_repo");
    const polymarketSources = enabledSources.filter(s => s.sourceType === "polymarket");
    const stocktwitsSources = enabledSources.filter(s => s.sourceType === "stocktwits");
    const arxivSources = enabledSources.filter(s => s.sourceType === "arxiv");
    const ytSources = enabledSources.filter(s => s.sourceType === "youtube_channel");

    const webQueryItems = channelWeb ? queries.map(q => ({ id: channelWeb.id, value: q })) : [];
    const xQueryItems = channelX ? queries.map(q => ({ id: channelX.id, value: q })) : [];
    const xDiscoveryQueryItems = channelX ? discoveryQueries.map(q => ({ id: `discovery:${channelX.id}`, value: q })) : [];

    const allSignals: adapters.RawSignal[] = [];
    const errors: string[] = [];

    for (const source of enabledSources.filter(s => s.sourceType !== "pinned_topic")) {
      diagnostics.registerSource(source, scanStartedAt);
    }

    if (channelWeb && webQueryItems.length > 0) {
      try {
        const webSignals = await adapters.scanWebSources(webQueryItems.slice(0, ranking.LANDSCAPE_SCAN_BUDGET.maxSearchQueries));
        allSignals.push(...webSignals);
        diagnostics.recordAdapterResult([channelWeb.id], "success");
      } catch (err) {
        const message = (err as Error).message;
        errors.push(`web: ${message}`);
        diagnostics.recordAdapterResult([channelWeb.id], "failed", message);
      }
    }

    if (channelX && xQueryItems.length > 0) {
      try {
        const xSignals = await adapters.scanXSources(xQueryItems.slice(0, ranking.LANDSCAPE_SCAN_BUDGET.maxSearchQueries));
        allSignals.push(...xSignals);
        diagnostics.recordAdapterResult([channelX.id], "success");
      } catch (err) {
        const message = (err as Error).message;
        errors.push(`x: ${message}`);
        diagnostics.recordAdapterResult([channelX.id], "failed", message);
      }
    }

    if (channelX && xDiscoveryQueryItems.length > 0) {
      try {
        const xDiscoverySignals = await adapters.scanXSources(xDiscoveryQueryItems);
        allSignals.push(...xDiscoverySignals.map(signal => ({
          ...signal,
          sourceId: channelX.id,
          rawMetadata: { ...signal.rawMetadata, discoveryMode: "x_news_discovery" },
        })));
        diagnostics.recordAdapterResult([channelX.id], "success");
      } catch (err) {
        const message = (err as Error).message;
        errors.push(`x_discovery: ${message}`);
        diagnostics.recordAdapterResult([channelX.id], "partial", message);
      }
    }

    // ── Direct source dispatch table ──────────────────────────────
    // Each entry: label for error tracking, sources array, adapter function.
    // Adding a new source type = one new entry here.
    const directDispatches: Array<{
      label: string;
      sources: typeof subreddits;
      adapter: (items: Array<{ id: string; value: string }>) => Promise<adapters.RawSignal[]>;
    }> = [
      { label: "reddit", sources: subreddits, adapter: adapters.scanRedditSources },
      { label: "rss", sources: rssFeeds, adapter: adapters.scanRssSources },
      { label: "hackernews", sources: hnSources, adapter: adapters.scanHackerNewsSources },
      { label: "github_repo", sources: githubRepos, adapter: adapters.scanGitHubRepoSources },
      { label: "polymarket", sources: polymarketSources, adapter: adapters.scanPolymarketSources },
      { label: "stocktwits", sources: stocktwitsSources, adapter: adapters.scanStockTwitsSources },
      { label: "arxiv", sources: arxivSources, adapter: adapters.scanArxivSources },
      { label: "youtube_channel", sources: ytSources, adapter: adapters.scanYouTubeChannelSources },
    ];

    for (const { label, sources, adapter } of directDispatches) {
      if (sources.length === 0) continue;
      try {
        const signals = await adapter(sources.map(s => ({ id: s.id, value: s.value })));
        allSignals.push(...signals);
        diagnostics.recordAdapterResult(sources.map(s => s.id), "success");
      } catch (err) {
        const message = (err as Error).message;
        errors.push(`${label}: ${message}`);
        diagnostics.recordAdapterResult(sources.map(s => s.id), "failed", message);
      }
    }

    // X account timeline has a special return shape (resolvedIds), so it stays inline
    if (xAccounts.length > 0) {
      try {
        const { signals: xAccountSignals, resolvedIds } =
          await adapters.scanXAccountTimeline(xAccounts.map(s => ({
            id: s.id,
            value: s.value,
            cachedUserId: s.cachedUserId ?? undefined,
          })));
        allSignals.push(...xAccountSignals);
        diagnostics.recordAdapterResult(xAccounts.map(s => s.id), "success");
        for (const [sourceId, userId] of resolvedIds) {
          await signalStorage.updateSource(sourceId, { cachedUserId: userId });
        }
      } catch (err) {
        const message = (err as Error).message;
        errors.push(`x_accounts: ${message}`);
        diagnostics.recordAdapterResult(xAccounts.map(s => s.id), "failed", message);
      }
    }

    const qualityCandidates = gateRawSignals(diagnostics, allSignals, { sources: enabledSources, interestGraph });
    const acceptedSignals = qualityCandidates.map(candidate => candidate.raw);
    const preDedup = acceptedSignals.length;
    const storyClusters = adapters.clusterSignalsByStory(acceptedSignals);
    const dedupedSignals = storyClusters.map(cluster => cluster.primary);
    const clusterByUrl = new Map(storyClusters.map(cluster => [cluster.primary.url, cluster]));
    const storyDeduped = preDedup - dedupedSignals.length;
    for (const cluster of storyClusters) {
      for (const duplicate of cluster.signals.filter(signal => signal !== cluster.primary)) {
        diagnostics.recordDeduped(duplicate.sourceId);
      }
    }
    log.log(`scan: story dedup removed ${storyDeduped} duplicates (${preDedup} → ${dedupedSignals.length})`);

    const activeTheses = await thesisStorage.list({ status: "active" });
    const thesisData = activeTheses.map(t => ({ id: t.id, tags: t.tags || [], title: t.title }));
    const skillNames = await loadDomainSkillNames();

    let itemsSurfaced = 0;
    let itemsDeduped = storyDeduped;
    const relevanceThreshold = 0.3;
    const dailySurfaceLimit = 3;
    const surfacedToday = await signalStorage.countSurfacedToday("America/Chicago");
    let remainingSurfaceSlots = Math.max(0, dailySurfaceLimit - surfacedToday);
    const staleSurfacedDismissed = await signalStorage.dismissStaleSurfacedSignals(3);
    if (staleSurfacedDismissed > 0) {
      log.log(`scan: auto-dismissed ${staleSurfacedDismissed} surfaced signals older than 3 days`);
    }

    const scoredSignals = dedupedSignals
      .map(raw => {
        const fingerprint = adapters.computeFingerprint(raw.url);
        const scored = adapters.scoreSignalRelevance(
          { ...raw, rawMetadata: { ...raw.rawMetadata, __fingerprint: fingerprint } },
          interestGraph,
          skillNames,
          thesisData,
        );
        return { raw, scored, fingerprint, cluster: clusterByUrl.get(raw.url) ?? { primary: raw, signals: [raw], sourceTypes: [raw.sourceType], titles: [raw.title] } };
      })
      .sort((a, b) => b.scored.relevanceScore - a.scored.relevanceScore);

    const rankedSignals = scoredSignals.map(entry => ranking.rankSignal(entry, interestGraph));
    const selectedCandidates = ranking.selectCurationCandidates(rankedSignals);
    const selectionByFingerprint = new Map(selectedCandidates.map(selection => [selection.fingerprint, selection]));
    log.log(`scan: selected ${selectedCandidates.length} curation candidates by lane (${selectedCandidates.map(s => `${s.lane}:${s.selectionScore}`).join(", ")})`);

    // ── Skill-based curation ───────────────────────────────────────
    let skillDecisions: Map<string, CurationDecision> | null = null;
    if (selectedCandidates.length > 0) {
      try {
        // Serialize candidates with article text for the skill
        const candidatePayloads = await Promise.all(
          selectedCandidates.map(async (selection) => {
            const entry = scoredSignals.find(s => s.fingerprint === selection.fingerprint);
            if (!entry) return null;
            const { raw, scored } = entry;
            const readable = await adapters.fetchReadableArticleText(raw.url, 4000);
            return {
              fingerprint: selection.fingerprint,
              url: raw.url,
              title: raw.title,
              snippet: raw.snippet,
              sourceType: raw.sourceType,
              heuristicScore: scored.relevanceScore,
              heuristicTags: scored.relevanceTags,
              articleText: readable.text || "",
            };
          }),
        );
        const validPayloads = candidatePayloads.filter(Boolean);

        log.log(`scan: invoking news-curation skill for ${validPayloads.length} candidates`);
        await executeAutonomousSkillRun("news-curation", {
          preContext: JSON.stringify({ candidates: validPayloads }),
          spawnReason: "news-curation-scan",
        });

        const decisions = await readCurationResults();
        if (decisions && decisions.length > 0) {
          skillDecisions = new Map(decisions.map(d => [d.fingerprint, d]));
          log.log(`scan: skill returned ${decisions.length} curation decisions`);
        } else {
          log.warn("scan: skill returned no curation decisions, falling back to per-candidate curation");
        }
      } catch (err) {
        log.warn(`scan: skill curation failed (${err instanceof Error ? err.message : String(err)}), falling back to per-candidate curation`);
      }
    }

    for (const { raw, scored, fingerprint } of scoredSignals) {
      const selection = selectionByFingerprint.get(fingerprint);
      let curated: adapters.CuratedSignal;

      if (selection && skillDecisions?.has(fingerprint)) {
        // Use skill decision
        const decision = skillDecisions.get(fingerprint)!;
        const isRelevant = decision.isRelevant && decision.score >= 0.45;
        curated = {
          ...scored,
          relevanceScore: Math.max(scored.relevanceScore, decision.score),
          curatedTitle: isRelevant && decision.reason ? decision.title : null,
          curatedReason: isRelevant && decision.reason ? decision.reason : null,
          curationStatus: "read" as const,
          curationScore: decision.score,
          matchedTopics: decision.matchedTopics?.length ? decision.matchedTopics : scored.relevanceTags,
          agentSummary: decision.summary ?? null,
        };
      } else if (selection && !skillDecisions) {
        // Fallback: skill failed entirely, use per-candidate curation
        curated = await adapters.curateSignalCandidate(scored, interestGraph);
      } else {
        // Not a selected candidate — uncurated
        curated = {
          ...scored,
          curatedTitle: null,
          curatedReason: null,
          curationStatus: "unread" as const,
          curationScore: null,
          matchedTopics: scored.relevanceTags,
          agentSummary: null,
        };
      }
      const ranked = rankedSignals.find(signal => signal.rawMetadata.__fingerprint === fingerprint);
      const qualifiesForSurface = Boolean(curated.curatedTitle && curated.curatedReason && ((curated.curationScore ?? curated.relevanceScore) >= 0.45 || (ranked?.importanceScore ?? 0) >= 0.45));
      const shouldSurface = qualifiesForSurface && remainingSurfaceSlots > 0;
      const status = shouldSurface ? "surfaced" : qualifiesForSurface ? "new" : scored.relevanceScore >= relevanceThreshold ? "new" : "archived";

      const { item, isNew } = await signalStorage.upsertSignal({
        sourceType: raw.sourceType,
        sourceId: raw.sourceId,
        url: raw.url,
        title: raw.title,
        snippet: raw.snippet,
        agentSummary: curated.agentSummary,
        curatedTitle: curated.curatedTitle,
        curatedReason: curated.curatedReason,
        curationStatus: curated.curationStatus,
        curationScore: curated.curationScore,
        matchedTopics: curated.matchedTopics,
        curatedAt: curated.curationStatus !== "unread" ? new Date() : null,
        publishedAt: raw.publishedAt ? new Date(raw.publishedAt) : null,
        relevanceScore: curated.relevanceScore,
        relevanceTags: curated.relevanceTags,
        matchingSkills: curated.matchingSkills,
        matchingTheses: curated.matchingTheses,
        fingerprint,
        status,
      });

      diagnostics.recordPersisted(raw.sourceId);

      if (isNew && status === "surfaced") {
        diagnostics.recordSurfaced(raw.sourceId);
        itemsSurfaced++;
        remainingSurfaceSlots--;
      } else if (!isNew) {
        itemsDeduped++;
        if (qualifiesForSurface && item.status === "new" && remainingSurfaceSlots > 0) {
          await signalStorage.surfaceSignal(item.id);
          diagnostics.recordSurfaced(raw.sourceId);
          itemsSurfaced++;
          remainingSurfaceSlots--;
        }
      }
    }

    // ── Per-source status tracking ──────────────────────────────────
    // Build dispatched IDs from all source arrays (channels + direct + x_accounts)
    const allDispatchedIds = new Set<string>();
    if (channelWeb) allDispatchedIds.add(channelWeb.id);
    if (channelX) allDispatchedIds.add(channelX.id);
    for (const { sources } of directDispatches) {
      for (const s of sources) allDispatchedIds.add(s.id);
    }
    for (const s of xAccounts) allDispatchedIds.add(s.id);

    const signalsBySource = new Map<string, number>();
    for (const s of allSignals) {
      signalsBySource.set(s.sourceId, (signalsBySource.get(s.sourceId) || 0) + 1);
    }

    // Map dispatch labels to source IDs for reliable error-to-source matching
    const sourceIdToErrorLabel = new Map<string, string>();
    for (const { label, sources } of directDispatches) {
      for (const s of sources) sourceIdToErrorLabel.set(s.id, label);
    }
    for (const s of xAccounts) sourceIdToErrorLabel.set(s.id, "x_accounts");
    if (channelWeb) sourceIdToErrorLabel.set(channelWeb.id, "web");
    if (channelX) sourceIdToErrorLabel.set(channelX.id, "x");

    for (const sourceId of allDispatchedIds) {
      const count = signalsBySource.get(sourceId) || 0;
      const errorLabel = sourceIdToErrorLabel.get(sourceId);
      const sourceError = errorLabel ? errors.find(e =>
        e.startsWith(`${errorLabel}:`)
      ) : undefined;

      await signalStorage.touchSourceAttempt(sourceId, sourceError || undefined);
      if (count > 0) {
        await signalStorage.touchSourceScan(sourceId, count);
      }
    }

    await signalStorage.archiveStaleSignals(30);

    // Count all dispatched sources (channels + direct + x_accounts)
    const sourcesScannedCount = allDispatchedIds.size;
    const actualSurfaced = await signalStorage.countSurfacedSince(scanStartedAt);
    if (actualSurfaced !== itemsSurfaced) {
      log.warn(`scan: surfaced counter reconciled from ${itemsSurfaced} to actual stored count ${actualSurfaced}`);
    }
    await signalStorage.saveSourceScanDiagnostics(diagnostics.finalize().map(row => ({
      scanRunId: row.scanRunId,
      sourceId: row.sourceId,
      sourceType: row.sourceType,
      sourceValue: row.sourceValue,
      adapterStatus: row.adapterStatus,
      fetchedCount: row.fetchedCount,
      acceptedCount: row.acceptedCount,
      rejectedCount: row.rejectedCount,
      persistedCount: row.persistedCount,
      surfacedCount: row.surfacedCount,
      dedupedCount: row.dedupedCount,
      rejectedByReason: row.rejectedByReason,
      lastError: row.lastError ?? null,
      startedAt: row.startedAt,
      completedAt: row.completedAt ?? new Date(),
    })));

    await signalStorage.completeScanRun(scanRun.id, {
      sourcesScanned: sourcesScannedCount,
      itemsFound: allSignals.length,
      itemsSurfaced: actualSurfaced,
      itemsDeduped,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    });

    const message = `Scan complete. Sources: ${sourcesScannedCount}, Signals found: ${allSignals.length}, Surfaced: ${actualSurfaced}, Deduped: ${itemsDeduped}${errors.length > 0 ? `. Errors: ${errors.join("; ")}` : ""}`;
    return {
      outcome: "completed",
      sourcesScanned: sourcesScannedCount,
      itemsFound: allSignals.length,
      itemsSurfaced: actualSurfaced,
      itemsDeduped,
      errors,
      message,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await signalStorage.saveSourceScanDiagnostics(diagnostics.finalize().map(row => ({
        scanRunId: row.scanRunId,
        sourceId: row.sourceId,
        sourceType: row.sourceType,
        sourceValue: row.sourceValue,
        adapterStatus: row.lastError ? row.adapterStatus : "failed",
        fetchedCount: row.fetchedCount,
        acceptedCount: row.acceptedCount,
        rejectedCount: row.rejectedCount,
        persistedCount: row.persistedCount,
        surfacedCount: row.surfacedCount,
        dedupedCount: row.dedupedCount,
        rejectedByReason: row.rejectedByReason,
        lastError: row.lastError ?? msg,
        startedAt: row.startedAt,
        completedAt: row.completedAt ?? new Date(),
      })));
    } catch (diagnosticsErr) {
      log.warn(`scan: failed to persist source diagnostics after scan failure (${diagnosticsErr instanceof Error ? diagnosticsErr.message : String(diagnosticsErr)})`);
    }
    try {
      await signalStorage.completeScanRun(scanRun.id, {
        sourcesScanned: 0,
        itemsFound: 0,
        itemsSurfaced: 0,
        itemsDeduped: 0,
        error: msg,
      });
    } catch (completionErr) {
      log.error(
        `scan: failed to finalize failed run ${scanRun.id}: ${completionErr instanceof Error ? completionErr.message : String(completionErr)}`,
      );
    }
    return {
      outcome: "failed",
      sourcesScanned: 0,
      itemsFound: 0,
      itemsSurfaced: 0,
      itemsDeduped: 0,
      errors: [msg],
      message: `Scan failed: ${msg}`,
    };
  }
}

export interface CurationDecision {
  fingerprint: string;
  isRelevant: boolean;
  score: number;
  title: string;
  reason: string;
  matchedTopics: string[];
  summary?: string;
}

const CURATION_RESULTS_KEY = "skill.news-curation.lastResults";

/**
 * Reads and clears the skill curation results written by the news-curation skill
 * via the batch_curate tool action.
 */
export async function readCurationResults(): Promise<CurationDecision[] | null> {
  try {
    const results = await getSetting<CurationDecision[]>(CURATION_RESULTS_KEY);
    if (!results || !Array.isArray(results)) return null;
    // Clear after reading so stale results aren't reused
    await setSetting(CURATION_RESULTS_KEY, null);
    return results;
  } catch {
    return null;
  }
}
