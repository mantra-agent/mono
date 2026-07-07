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

const log = createLogger("LandscapeScanService");

export interface LandscapeScanResult {
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

export async function runLandscapeScan(): Promise<LandscapeScanResult> {
  const inProgress = await signalStorage.hasInProgressScan();
  if (inProgress) {
    throw new Error("A scan is already in progress. Try again later.");
  }

  const scanRun = await signalStorage.startScanRun();
  const scanStartedAt = scanRun.startedAt ?? new Date();

  try {
    await signalStorage.migrateChannelsAndTopics();
    const invalidXArticleLinksArchived = await signalStorage.archiveInvalidXArticleLinks();
    if (invalidXArticleLinksArchived > 0) {
      log.log(`scan: archived ${invalidXArticleLinksArchived} invalid X/Grok Story links before ranking`);
    }

    const allSources = await signalStorage.listSources();
    const enabledSources = allSources.filter(s => s.enabled);

    const hasChannels = enabledSources.some(s => s.sourceType === "channel_x" || s.sourceType === "channel_web");
    const hasDirectSources = enabledSources.some(s => ["subreddit", "rss_feed", "x_account"].includes(s.sourceType));
    if (!hasChannels && !hasDirectSources) {
      await signalStorage.completeScanRun(scanRun.id, {
        sourcesScanned: 0,
        itemsFound: 0,
        itemsSurfaced: 0,
        itemsDeduped: 0,
        error: "No enabled channels or sources configured",
      });
      return {
        sourcesScanned: 0,
        itemsFound: 0,
        itemsSurfaced: 0,
        itemsDeduped: 0,
        errors: [],
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

    const webQueryItems = channelWeb ? queries.map(q => ({ id: channelWeb.id, value: q })) : [];
    const xQueryItems = channelX ? queries.map(q => ({ id: channelX.id, value: q })) : [];
    const xDiscoveryQueryItems = channelX ? discoveryQueries.map(q => ({ id: `discovery:${channelX.id}`, value: q })) : [];

    const allSignals: adapters.RawSignal[] = [];
    const errors: string[] = [];

    if (channelWeb && webQueryItems.length > 0) {
      try {
        const webSignals = await adapters.scanWebSources(webQueryItems.slice(0, ranking.LANDSCAPE_SCAN_BUDGET.maxSearchQueries));
        allSignals.push(...webSignals);
      } catch (err) { errors.push(`web: ${(err as Error).message}`); }
    }

    if (channelX && xQueryItems.length > 0) {
      try {
        const xSignals = await adapters.scanXSources(xQueryItems.slice(0, ranking.LANDSCAPE_SCAN_BUDGET.maxSearchQueries));
        allSignals.push(...xSignals);
      } catch (err) { errors.push(`x: ${(err as Error).message}`); }
    }

    if (channelX && xDiscoveryQueryItems.length > 0) {
      try {
        const xDiscoverySignals = await adapters.scanXSources(xDiscoveryQueryItems);
        allSignals.push(...xDiscoverySignals.map(signal => ({
          ...signal,
          sourceId: channelX.id,
          rawMetadata: { ...signal.rawMetadata, discoveryMode: "x_news_discovery" },
        })));
      } catch (err) { errors.push(`x_discovery: ${(err as Error).message}`); }
    }

    try {
      const redditSignals = await adapters.scanRedditSources(subreddits.map(s => ({ id: s.id, value: s.value })));
      allSignals.push(...redditSignals);
    } catch (err) { errors.push(`reddit: ${(err as Error).message}`); }

    try {
      const rssSignals = await adapters.scanRssSources(rssFeeds.map(s => ({ id: s.id, value: s.value })));
      allSignals.push(...rssSignals);
    } catch (err) { errors.push(`rss: ${(err as Error).message}`); }

    if (xAccounts.length > 0) {
      try {
        const { signals: xAccountSignals, resolvedIds } =
          await adapters.scanXAccountTimeline(xAccounts.map(s => ({
            id: s.id,
            value: s.value,
            cachedUserId: s.cachedUserId ?? undefined,
          })));
        allSignals.push(...xAccountSignals);
        for (const [sourceId, userId] of resolvedIds) {
          await signalStorage.updateSource(sourceId, { cachedUserId: userId });
        }
      } catch (err) { errors.push(`x_accounts: ${(err as Error).message}`); }
    }

    const preDedup = allSignals.length;
    const storyClusters = adapters.clusterSignalsByStory(allSignals);
    const dedupedSignals = storyClusters.map(cluster => cluster.primary);
    const clusterByUrl = new Map(storyClusters.map(cluster => [cluster.primary.url, cluster]));
    const storyDeduped = preDedup - dedupedSignals.length;
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
      .filter(raw => raw.url && raw.title)
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

      if (isNew && status === "surfaced") {
        itemsSurfaced++;
        remainingSurfaceSlots--;
      } else if (!isNew) {
        itemsDeduped++;
        if (qualifiesForSurface && item.status === "new" && remainingSurfaceSlots > 0) {
          await signalStorage.surfaceSignal(item.id);
          itemsSurfaced++;
          remainingSurfaceSlots--;
        }
      }
    }

    const allDispatchedIds = new Set<string>();
    if (channelWeb) allDispatchedIds.add(channelWeb.id);
    if (channelX) allDispatchedIds.add(channelX.id);
    for (const s of [...subreddits, ...rssFeeds, ...xAccounts]) {
      allDispatchedIds.add(s.id);
    }

    const signalsBySource = new Map<string, number>();
    for (const s of allSignals) {
      signalsBySource.set(s.sourceId, (signalsBySource.get(s.sourceId) || 0) + 1);
    }

    for (const sourceId of allDispatchedIds) {
      const count = signalsBySource.get(sourceId) || 0;
      const source = enabledSources.find(s => s.id === sourceId);
      const sourceError = source ? errors.find(e =>
        e.toLowerCase().startsWith(source.sourceType.replace(/_/g, ""))
      ) : undefined;

      await signalStorage.touchSourceAttempt(sourceId, sourceError || undefined);
      if (count > 0) {
        await signalStorage.touchSourceScan(sourceId, count);
      }
    }

    await signalStorage.archiveStaleSignals(30);

    const sourcesScannedCount = (channelWeb ? 1 : 0) + (channelX ? 1 : 0) + subreddits.length + rssFeeds.length + xAccounts.length;
    const actualSurfaced = await signalStorage.countSurfacedSince(scanStartedAt);
    if (actualSurfaced !== itemsSurfaced) {
      log.warn(`scan: surfaced counter reconciled from ${itemsSurfaced} to actual stored count ${actualSurfaced}`);
    }
    await signalStorage.completeScanRun(scanRun.id, {
      sourcesScanned: sourcesScannedCount,
      itemsFound: allSignals.length,
      itemsSurfaced: actualSurfaced,
      itemsDeduped,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    });

    const message = `Scan complete. Sources: ${sourcesScannedCount}, Signals found: ${allSignals.length}, Surfaced: ${actualSurfaced}, Deduped: ${itemsDeduped}${errors.length > 0 ? `. Errors: ${errors.join("; ")}` : ""}`;
    return { sourcesScanned: sourcesScannedCount, itemsFound: allSignals.length, itemsSurfaced: actualSurfaced, itemsDeduped, errors, message };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await signalStorage.completeScanRun(scanRun.id, {
      sourcesScanned: 0,
      itemsFound: 0,
      itemsSurfaced: 0,
      itemsDeduped: 0,
      error: msg,
    });
    throw err;
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
