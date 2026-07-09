import { createLogger } from "./log";
import { getSecretSync } from "./secrets-store";
import { createHash } from "crypto";
import { ACTIVITY_FRAMING } from "./job-profiles";

const log = createLogger("LandscapeAdapters");

// ── Types ──────────────────────────────────────────────────────────
const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export interface RawSignal {
  sourceType: "x" | "x_account" | "web" | "reddit" | "rss" | "hackernews" | "github" | "polymarket" | "stocktwits" | "arxiv" | "youtube";
  sourceId: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  rawMetadata: Record<string, unknown>;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export interface InterestTopic {
  tag: string;
  weight: number;
  source: "pinned" | "skill" | "goal" | "thesis" | "session";
  sourceRef: string;
}

export interface ScoredSignal extends RawSignal {
  relevanceScore: number;
  relevanceTags: string[];
  matchingSkills: string[];
  matchingTheses: string[];
}

export interface CuratedSignal extends ScoredSignal {
  curatedTitle: string | null;
  curatedReason: string | null;
  curationStatus: "unread" | "snippet_only" | "read" | "failed";
  curationScore: number | null;
  matchedTopics: string[];
  agentSummary: string | null;
}

// ── Fingerprint ────────────────────────────────────────────────────
export function computeFingerprint(url: string): string {
  // Normalize URL: strip protocol, trailing slashes, common tracking params
  const normalized = url
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/[?&](utm_\w+|ref|source|fbclid|gclid)=[^&]*/g, "")
    .toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ── Story-Level Deduplication ──────────────────────────────────────

export interface StoryCluster {
  primary: RawSignal;
  signals: RawSignal[];
  sourceTypes: string[];
  titles: string[];
}

function normalizeStoryTitle(title: string): string {
  return title.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) { if (b.has(x)) intersection++; }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Cluster signals by title similarity while preserving consensus evidence.
 * The compatibility wrapper `deduplicateByStory` still returns primaries only.
 */
export function clusterSignalsByStory(signals: RawSignal[]): StoryCluster[] {
  if (signals.length <= 1) return signals.map(signal => ({
    primary: signal,
    signals: [signal],
    sourceTypes: [signal.sourceType],
    titles: [signal.title],
  }));

  const entries = signals.map(s => ({
    signal: s,
    words: new Set(normalizeStoryTitle(s.title).split(" ").filter(w => w.length > 2)),
  }));

  const clusters: RawSignal[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = [entries[i].signal];
    assigned.add(i);

    for (let j = i + 1; j < entries.length; j++) {
      if (assigned.has(j)) continue;
      if (jaccard(entries[i].words, entries[j].words) > 0.5) {
        cluster.push(entries[j].signal);
        assigned.add(j);
      }
    }
    clusters.push(cluster);
  }

  return clusters.map(cluster => {
    const primary = cluster.reduce((best, s) => s.snippet.length > best.snippet.length ? s : best);
    return {
      primary,
      signals: cluster,
      sourceTypes: [...new Set(cluster.map(s => s.sourceType))],
      titles: [...new Set(cluster.map(s => s.title))],
    };
  });
}

export function deduplicateByStory(signals: RawSignal[]): RawSignal[] {
  return clusterSignalsByStory(signals).map(cluster => cluster.primary);
}

// ── Source Adapters ────────────────────────────────────────────────

export async function scanWebSources(keywords: Array<{ id: string; value: string }>): Promise<RawSignal[]> {
  const apiKey = getSecretSync("BRAVE_API_KEY") || getSecretSync("BRAVE_SEARCH_API_KEY");
  if (!apiKey) {
    log.warn("scanWebSources: No Brave API key configured, skipping web scan");
    return [];
  }

  const signals: RawSignal[] = [];
  for (const source of keywords) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(source.value)}&count=10&freshness=pd`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        log.warn(`scanWebSources: Brave API error ${response.status} for "${source.value}"`);
        continue;
      }

      const data = await response.json() as any;
      const results = (data.web?.results || []).slice(0, 10);
      for (const r of results) {
        if (!r.url || !r.title) continue;
        signals.push({
          sourceType: "web",
          sourceId: source.id,
          title: r.title,
          url: r.url,
          snippet: cleanHumanText(r.description || "", 500),
          publishedAt: r.age ? null : null, // Brave doesn't reliably provide dates
          rawMetadata: { query: source.value },
        });
      }
      log.log(`scanWebSources: "${source.value}" returned ${results.length} results`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`scanWebSources: error scanning "${source.value}": ${msg}`);
    }
  }
  return signals;
}

export async function scanXSources(keywords: Array<{ id: string; value: string }>): Promise<RawSignal[]> {
  const signals: RawSignal[] = [];
  try {
    const twitter = await import("./twitter");
    const account = await twitter.getFirstAccountTokens();
    if (!account || !account.tokens.bearerToken) {
      log.warn("scanXSources: No X account with Bearer Token configured, skipping");
      return [];
    }

    for (const source of keywords) {
      try {
        const response = await twitter.searchNews(account.tokens.bearerToken, source.value, 10);
        const results = Array.isArray((response as any)?.data) ? (response as any).data : [];
        let skippedWithoutCanonicalUrl = 0;
        for (const r of results) {
          const canonicalUrl = safeHttpsUrl(r.url || r.link || r.canonical_url || r.canonicalUrl);
          if (!canonicalUrl) {
            skippedWithoutCanonicalUrl++;
            continue;
          }
          signals.push({
            sourceType: "x",
            sourceId: source.id,
            title: r.name || r.title || r.headline || source.value,
            url: canonicalUrl,
            snippet: cleanHumanText(r.hook || r.summary || r.description || r.snippet || "", 500),
            publishedAt: r.updated_at || r.published_at || r.created_at || null,
            rawMetadata: {
              query: source.value,
              category: r.category || null,
              xNewsId: r.id || null,
              discoveryMode: source.id.startsWith("discovery:") ? "x_news_discovery" : "x_news_topic",
              urlSource: "x_news_payload",
            },
          });
        }
        log.log(`scanXSources: "${source.value}" returned ${results.length} results, kept ${results.length - skippedWithoutCanonicalUrl} with canonical URLs, skipped ${skippedWithoutCanonicalUrl} X/Grok Stories without canonical URLs`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`scanXSources: error scanning "${source.value}": ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`scanXSources: failed to load twitter module: ${msg}`);
  }
  return signals;
}

// ── X Account Timeline Scanner ─────────────────────────────────────

interface XAccountSource {
  id: string;
  value: string;
  cachedUserId?: string;
}

export async function scanXAccountTimeline(
  accounts: XAccountSource[]
): Promise<{ signals: RawSignal[]; resolvedIds: Map<string, string> }> {
  const signals: RawSignal[] = [];
  const resolvedIds = new Map<string, string>();

  try {
    const twitter = await import("./twitter");
    const account = await twitter.getFirstAccountTokens();
    if (!account?.tokens.bearerToken) {
      log.warn("scanXAccountTimeline: No Bearer Token configured, skipping");
      return { signals, resolvedIds };
    }
    const bearer = account.tokens.bearerToken;

    for (const source of accounts) {
      try {
        let userId = source.cachedUserId;
        if (!userId) {
          const user = await twitter.getUserByUsername(bearer, source.value);
          if (!user) {
            log.warn(`scanXAccountTimeline: user @${source.value} not found`);
            continue;
          }
          userId = user.id;
          resolvedIds.set(source.id, userId);
        }

        const tweets = await twitter.getUserTweets(bearer, userId, {
          maxResults: 50,
          excludeReplies: true,
          excludeRetweets: true,
        });

        for (const tweet of tweets) {
          const tweetUrl = `https://x.com/${source.value}/status/${tweet.id}`;
          signals.push({
            sourceType: "x_account",
            sourceId: source.id,
            title: tweet.text.slice(0, 200),
            url: tweetUrl,
            snippet: cleanHumanText(tweet.text, 500),
            publishedAt: tweet.created_at || null,
            rawMetadata: { account: source.value, tweetId: tweet.id },
          });
        }
        log.log(`scanXAccountTimeline: @${source.value} returned ${tweets.length} tweets`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`scanXAccountTimeline: error scanning @${source.value}: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`scanXAccountTimeline: failed to load twitter module: ${msg}`);
  }

  return { signals, resolvedIds };
}

// ── Reddit Scanner ─────────────────────────────────────────────────

/**
 * Fetch posts from a subreddit via its public RSS feed (Atom XML).
 * Returns parsed signals or null if the fetch fails.
 */
async function fetchRedditRss(subreddit: string, sourceId: string): Promise<RawSignal[] | null> {
  const url = `https://www.reddit.com/r/${subreddit}/.rss`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        "Accept": "application/atom+xml, application/xml, text/xml",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      log.debug(`fetchRedditRss: HTTP ${response.status} for r/${subreddit}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html") && !contentType.includes("xml")) {
      log.debug(`fetchRedditRss: r/${subreddit} returned HTML instead of XML`);
      return null;
    }

    const xml = await response.text();
    const items = parseRssItems(xml);
    if (items.length === 0) {
      log.debug(`fetchRedditRss: r/${subreddit} RSS returned 0 items`);
      return null;
    }

    const signals: RawSignal[] = [];
    for (const item of items.slice(0, 25)) {
      if (!item.link) continue;
      signals.push({
        sourceType: "reddit",
        sourceId,
        title: item.title || "",
        url: item.link,
        snippet: cleanHumanText(item.description || "", 500),
        publishedAt: item.pubDate || null,
        rawMetadata: { subreddit, fetchPath: "rss" },
      });
    }
    return signals;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * Fallback: fetch posts from arctic-shift community API.
 * Returns parsed signals or null if the fetch fails.
 */
async function fetchRedditArcticShift(subreddit: string, sourceId: string): Promise<RawSignal[] | null> {
  const url = `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${encodeURIComponent(subreddit)}&limit=25&sort=desc`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      log.debug(`fetchRedditArcticShift: HTTP ${response.status} for r/${subreddit}`);
      return null;
    }

    const data = await response.json() as any;
    const posts: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    if (posts.length === 0) return null;

    const signals: RawSignal[] = [];
    for (const post of posts) {
      if (!post || post.stickied) continue;
      const postUrl = post.url || (post.permalink ? `https://www.reddit.com${post.permalink}` : null);
      if (!postUrl) continue;
      signals.push({
        sourceType: "reddit",
        sourceId,
        title: post.title || "",
        url: postUrl,
        snippet: cleanHumanText(post.selftext || "", 500),
        publishedAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
        rawMetadata: { subreddit, score: post.score, numComments: post.num_comments, fetchPath: "arctic-shift" },
      });
    }
    return signals;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

export async function scanRedditSources(subreddits: Array<{ id: string; value: string }>): Promise<RawSignal[]> {
  const signals: RawSignal[] = [];
  for (const source of subreddits) {
    try {
      const subreddit = source.value.replace(/^\/?(r\/)?/, "");
      // Rate limit: space requests 2s apart
      if (signals.length > 0) await new Promise(r => setTimeout(r, 2000));

      // Primary: Reddit RSS feed (reliable from server IPs)
      const rssSignals = await fetchRedditRss(subreddit, source.id);
      if (rssSignals && rssSignals.length > 0) {
        signals.push(...rssSignals);
        log.log(`scanRedditSources: r/${subreddit} returned ${rssSignals.length} posts via RSS`);
        continue;
      }

      // Fallback: arctic-shift community API
      const arcticSignals = await fetchRedditArcticShift(subreddit, source.id);
      if (arcticSignals && arcticSignals.length > 0) {
        signals.push(...arcticSignals);
        log.warn(`scanRedditSources: r/${subreddit} returned ${arcticSignals.length} posts via arctic-shift fallback`);
        continue;
      }

      log.warn(`scanRedditSources: r/${subreddit} returned 0 posts from both RSS and arctic-shift`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`scanRedditSources: error scanning "${source.value}": ${msg}`);
    }
  }
  return signals;
}

export async function scanRssSources(feeds: Array<{ id: string; value: string }>): Promise<RawSignal[]> {
  const signals: RawSignal[] = [];
  for (const source of feeds) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(source.value, {
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Accept": "application/rss+xml, application/xml, text/xml, application/atom+xml",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        log.warn(`scanRssSources: HTTP ${response.status} for ${source.value}`);
        continue;
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/html") && !contentType.includes("xml")) {
        log.warn(`scanRssSources: ${source.value} returned HTML instead of XML (likely Cloudflare challenge)`);
        continue;
      }

      const xml = await response.text();
      const items = parseRssItems(xml);
      for (const item of items.slice(0, 25)) {
        if (!item.link) continue;
        signals.push({
          sourceType: "rss",
          sourceId: source.id,
          title: item.title || "Untitled",
          url: item.link,
          snippet: cleanHumanText(item.description || "", 500),
          publishedAt: item.pubDate || null,
          rawMetadata: { feedUrl: source.value },
        });
      }
      log.log(`scanRssSources: ${source.value} returned ${items.length} items`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`scanRssSources: error scanning "${source.value}": ${msg}`);
    }
  }
  return signals;
}

// Simple RSS/Atom XML parser using regex (no external library)
function parseRssItems(xml: string): Array<{ title?: string; link?: string; description?: string; pubDate?: string }> {
  const items: Array<{ title?: string; link?: string; description?: string; pubDate?: string }> = [];

  // Try RSS 2.0 format first (<item>...</item>)
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  if (rssItems.length > 0) {
    for (const itemXml of rssItems) {
      items.push({
        title: extractTag(itemXml, "title"),
        link: extractTag(itemXml, "link"),
        description: extractTag(itemXml, "description"),
        pubDate: extractTag(itemXml, "pubDate") || extractTag(itemXml, "dc:date"),
      });
    }
    return items;
  }

  // Try Atom format (<entry>...</entry>)
  const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const entryXml of atomEntries) {
    const linkMatch = entryXml.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    items.push({
      title: extractTag(entryXml, "title"),
      link: linkMatch?.[1] || extractTag(entryXml, "link"),
      description: extractTag(entryXml, "summary") || extractTag(entryXml, "content"),
      pubDate: extractTag(entryXml, "published") || extractTag(entryXml, "updated"),
    });
  }
  return items;
}

function extractTag(xml: string, tag: string): string | undefined {
  // Handle CDATA content
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, "i");
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  // Handle regular text content
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(regex);
  if (match) {
    // Strip HTML tags from content
    return cleanHumanText(match[1]);
  }
  return undefined;
}

// ── Hacker News Scanner ────────────────────────────────────────────

const HN_ALGOLIA_BASE = "https://hn.algolia.com/api/v1";
const HN_FIREBASE_BASE = "https://hacker-news.firebaseio.com/v0";
const HN_CONCURRENCY_CAP = 5;

async function fetchHnAlgoliaSearch(query: string, sourceId: string): Promise<RawSignal[]> {
  const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const url = `${HN_ALGOLIA_BASE}/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=25&numericFilters=created_at_i>${oneDayAgo}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": BROWSER_USER_AGENT } });
    if (!response.ok) {
      log.debug(`fetchHnAlgoliaSearch: HTTP ${response.status} for query "${query}"`);
      return [];
    }
    const data = await response.json() as { hits?: Array<{ title?: string; url?: string; objectID?: string; points?: number; author?: string; created_at?: string; num_comments?: number; story_text?: string }> };
    if (!Array.isArray(data.hits)) return [];
    return data.hits
      .filter(h => h.title && (h.url || h.objectID))
      .map(h => ({
        sourceType: "hackernews" as const,
        sourceId,
        title: h.title!,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        snippet: h.story_text ? stripHtml(h.story_text).slice(0, 500) : "",
        publishedAt: h.created_at || null,
        rawMetadata: { points: h.points, author: h.author, numComments: h.num_comments, objectID: h.objectID },
      }));
  } catch (err) {
    log.warn(`fetchHnAlgoliaSearch: error for query "${query}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHnTopStories(sourceId: string, limit: number = 30): Promise<RawSignal[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${HN_FIREBASE_BASE}/topstories.json`, { signal: controller.signal });
    if (!response.ok) return [];
    const ids = (await response.json()) as number[];
    const topIds = ids.slice(0, limit);

    // Batch fetch items with concurrency cap
    const signals: RawSignal[] = [];
    for (let i = 0; i < topIds.length; i += HN_CONCURRENCY_CAP) {
      const batch = topIds.slice(i, i + HN_CONCURRENCY_CAP);
      const items = await Promise.all(batch.map(async (id) => {
        try {
          const itemResp = await fetch(`${HN_FIREBASE_BASE}/item/${id}.json`);
          if (!itemResp.ok) return null;
          return await itemResp.json() as { id?: number; title?: string; url?: string; score?: number; by?: string; time?: number; descendants?: number; type?: string };
        } catch { return null; }
      }));
      for (const item of items) {
        if (!item || !item.title || item.type !== "story") continue;
        signals.push({
          sourceType: "hackernews",
          sourceId,
          title: item.title,
          url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
          snippet: "",
          publishedAt: item.time ? new Date(item.time * 1000).toISOString() : null,
          rawMetadata: { points: item.score, author: item.by, numComments: item.descendants, hnId: item.id },
        });
      }
    }
    return signals;
  } catch (err) {
    log.warn(`fetchHnTopStories: error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function scanHackerNewsSources(sources: Array<{ id: string; value: string }>): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];
  for (const source of sources) {
    try {
      const query = source.value.trim();
      if (query === "*" || query === "") {
        // Wildcard or empty: fetch top stories
        const topSignals = await fetchHnTopStories(source.id);
        allSignals.push(...topSignals);
        log.log(`scanHackerNewsSources: "${query}" returned ${topSignals.length} top stories`);
      } else {
        // Keyword search via Algolia
        const searchSignals = await fetchHnAlgoliaSearch(query, source.id);
        allSignals.push(...searchSignals);
        log.log(`scanHackerNewsSources: "${query}" returned ${searchSignals.length} stories via Algolia`);
      }
    } catch (err) {
      log.warn(`scanHackerNewsSources: error scanning "${source.value}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return allSignals;
}

// ── GitHub Repo Scanner ────────────────────────────────────────────

const GITHUB_API_BASE = "https://api.github.com";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function getGitHubHeaders(): Record<string, string> {
  const token = getSecretSync("GITHUB_TOKEN");
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "MantraNewsScanner/1.0",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export async function scanGitHubRepoSources(repos: Array<{ id: string; value: string }>): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];
  const cutoff = new Date(Date.now() - SEVEN_DAYS_MS);
  const headers = getGitHubHeaders();

  for (const source of repos) {
    try {
      const repoPath = source.value.trim().replace(/^https?:\/\/github\.com\//, "");
      if (!repoPath.includes("/")) {
        log.warn(`scanGitHubRepoSources: invalid repo format "${source.value}", expected "owner/repo"`);
        continue;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`${GITHUB_API_BASE}/repos/${repoPath}/releases?per_page=10`, {
          signal: controller.signal,
          headers,
        });

        if (!response.ok) {
          log.debug(`scanGitHubRepoSources: HTTP ${response.status} for ${repoPath}/releases`);
          continue;
        }

        const releases = await response.json() as Array<{
          tag_name?: string; name?: string; body?: string;
          published_at?: string; html_url?: string; draft?: boolean; prerelease?: boolean;
        }>;

        let count = 0;
        for (const release of releases) {
          if (release.draft) continue;
          const publishedAt = release.published_at ? new Date(release.published_at) : null;
          if (!publishedAt || publishedAt < cutoff) continue;

          const repoName = repoPath.split("/")[1] || repoPath;
          const releaseName = release.name || release.tag_name || "release";
          const tagName = release.tag_name || "";

          allSignals.push({
            sourceType: "github",
            sourceId: source.id,
            title: `${repoName}: ${releaseName}${tagName && tagName !== releaseName ? ` (${tagName})` : ""}`,
            url: release.html_url || `https://github.com/${repoPath}/releases/tag/${tagName}`,
            snippet: release.body ? stripHtml(release.body).slice(0, 500) : "",
            publishedAt: release.published_at || null,
            rawMetadata: { repo: repoPath, tagName, prerelease: release.prerelease },
          });
          count++;
        }
        log.log(`scanGitHubRepoSources: ${repoPath} returned ${count} recent releases`);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      log.warn(`scanGitHubRepoSources: error scanning "${source.value}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return allSignals;
}

// ── Polymarket Scanner ─────────────────────────────────────────────

const POLYMARKET_API_BASE = "https://gamma-api.polymarket.com";

export async function scanPolymarketSources(sources: Array<{ id: string; value: string }>): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];
  for (const source of sources) {
    try {
      const tag = source.value.trim();
      const params = new URLSearchParams({
        limit: "25",
        active: "true",
        order: "volume",
        ascending: "false",
      });
      if (tag && tag !== "*") {
        params.set("tag", tag);
      }
      const url = `${POLYMARKET_API_BASE}/markets?${params}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": BROWSER_USER_AGENT },
        });
        if (!response.ok) {
          log.debug(`scanPolymarketSources: HTTP ${response.status} for tag "${tag}"`);
          continue;
        }
        const markets = await response.json() as Array<{
          question?: string; slug?: string; description?: string;
          outcomePrices?: string; volume?: string; volumeNum?: number;
          endDate?: string; image?: string;
          events?: Array<{ slug?: string; title?: string }>;
          active?: boolean; closed?: boolean;
        }>;
        if (!Array.isArray(markets)) continue;

        for (const market of markets) {
          if (!market.question) continue;

          // Parse outcome prices: "[\"0.475\", \"0.525\"]"
          let yesPrice = "";
          try {
            const prices = JSON.parse(market.outcomePrices || "[]") as string[];
            if (prices.length >= 1) {
              yesPrice = `${(parseFloat(prices[0]) * 100).toFixed(0)}%`;
            }
          } catch { /* ignore parse errors */ }

          const eventSlug = market.events?.[0]?.slug;
          const marketUrl = eventSlug
            ? `https://polymarket.com/event/${eventSlug}`
            : `https://polymarket.com/market/${market.slug || ""}`;

          const volumeStr = market.volumeNum
            ? `${Math.round(market.volumeNum).toLocaleString()}`
            : market.volume || "";

          const snippet = [
            yesPrice ? `Yes: ${yesPrice}` : "",
            volumeStr ? `Volume: ${volumeStr}` : "",
            market.description ? market.description.slice(0, 400) : "",
          ].filter(Boolean).join(" · ");

          allSignals.push({
            sourceType: "polymarket",
            sourceId: source.id,
            title: market.question,
            url: marketUrl,
            snippet,
            publishedAt: null,
            rawMetadata: {
              yesPrice: yesPrice || null,
              volume: market.volumeNum || null,
              endDate: market.endDate || null,
              tag,
            },
          });
        }
        log.log(`scanPolymarketSources: tag "${tag}" returned ${markets.length} markets`);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      log.warn(`scanPolymarketSources: error scanning "${source.value}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return allSignals;
}

// ── StockTwits Scanner ────────────────────────────────────────────

const STOCKTWITS_API_BASE = "https://api.stocktwits.com/api/2";

export async function scanStockTwitsSources(sources: Array<{ id: string; value: string }>): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];
  for (const source of sources) {
    try {
      const symbol = source.value.trim().toUpperCase();
      const endpoint = symbol === "TRENDING" || symbol === "*"
        ? `${STOCKTWITS_API_BASE}/streams/trending.json`
        : `${STOCKTWITS_API_BASE}/streams/symbol/${encodeURIComponent(symbol)}.json`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(endpoint, {
          signal: controller.signal,
          headers: { "User-Agent": BROWSER_USER_AGENT },
        });
        if (!response.ok) {
          log.debug(`scanStockTwitsSources: HTTP ${response.status} for "${symbol}"`);
          continue;
        }
        const data = await response.json() as {
          messages?: Array<{
            id?: number; body?: string; created_at?: string;
            user?: { username?: string };
            symbols?: Array<{ symbol?: string; title?: string }>;
            sentiment?: { basic?: string };
          }>;
        };
        if (!Array.isArray(data.messages)) continue;

        // Take top 25 messages, each becomes a signal
        const messages = data.messages.slice(0, 25);
        for (const msg of messages) {
          if (!msg.body) continue;
          const tickers = (msg.symbols || []).map(s => s.symbol).filter(Boolean);
          const primaryTicker = tickers[0] || symbol;
          const title = tickers.length > 0
            ? `${primaryTicker}: ${msg.body.slice(0, 120)}`
            : msg.body.slice(0, 140);

          allSignals.push({
            sourceType: "stocktwits",
            sourceId: source.id,
            title,
            url: `https://stocktwits.com/symbol/${primaryTicker}`,
            snippet: msg.body.slice(0, 500),
            publishedAt: msg.created_at || null,
            rawMetadata: {
              messageId: msg.id,
              username: msg.user?.username || null,
              tickers,
              sentiment: msg.sentiment?.basic || null,
            },
          });
        }
        log.log(`scanStockTwitsSources: "${symbol}" returned ${messages.length} messages`);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      log.warn(`scanStockTwitsSources: error scanning "${source.value}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return allSignals;
}

// ── arXiv ──────────────────────────────────────────────────────────

const ARXIV_API_BASE = "https://export.arxiv.org/api/query";
const ARXIV_RATE_LIMIT_MS = 3500; // arXiv requires ≥3s between requests

export async function scanArxivSources(sources: Array<{ id: string; value: string }>): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    try {
      // Rate-limit: wait between requests (skip first)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, ARXIV_RATE_LIMIT_MS));
      }

      const query = source.value.trim();
      // Detect arXiv category format (e.g., "cs.AI", "math.CO") vs keyword search
      const isCategory = /^[a-z-]+\.[A-Z]{2,}$/i.test(query);
      const searchQuery = isCategory
        ? `cat:${query}`
        : `all:${encodeURIComponent(query)}`;

      const url = `${ARXIV_API_BASE}?search_query=${searchQuery}&max_results=25&sortBy=submittedDate&sortOrder=descending`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": BROWSER_USER_AGENT },
        });

        if (!response.ok) {
          log.debug(`scanArxivSources: HTTP ${response.status} for "${query}"`);
          continue;
        }

        const xml = await response.text();
        const items = parseRssItems(xml);
        let count = 0;

        for (const item of items) {
          if (!item.title || !item.link) continue;

          // Filter to last 7 days if pubDate available
          if (item.pubDate) {
            const pubTime = new Date(item.pubDate).getTime();
            if (!isNaN(pubTime) && pubTime < sevenDaysAgo) continue;
          }

          // Extract arXiv ID from link (e.g., http://arxiv.org/abs/2407.12345v1)
          const arxivUrl = item.link.replace(/^http:/, "https:");

          allSignals.push({
            sourceType: "arxiv",
            sourceId: source.id,
            title: item.title.replace(/\s+/g, " ").trim(),
            url: arxivUrl,
            snippet: (item.description || "").slice(0, 500),
            publishedAt: item.pubDate || null,
            rawMetadata: {
              query,
              isCategory,
            },
          });
          count++;
        }
        log.log(`scanArxivSources: "${query}" returned ${count} recent papers`);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      log.warn(`scanArxivSources: error scanning "${source.value}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return allSignals;
}

// ── Interest Graph ─────────────────────────────────────────────────

export async function buildInterestGraph(): Promise<InterestTopic[]> {
  const topics: InterestTopic[] = [];

  // 1. Pinned topics from signal_sources (type = 'pinned_topic')
  try {
    const { signalStorage } = await import("./news-storage");
    const pinnedSources = await signalStorage.listSources({ sourceType: "pinned_topic" });
    for (const s of pinnedSources) {
      if (s.enabled) {
        topics.push({ tag: s.value, weight: 1.0, source: "pinned", sourceRef: s.id });
      }
    }

    const sessionTopics = await signalStorage.getRecentSessionTopics({ days: 14, limit: 40 });
    for (const t of sessionTopics) {
      const ageDays = Math.max(0, (Date.now() - t.lastSeenAt.getTime()) / 86_400_000);
      const recency = ageDays <= 2 ? 0.75 : ageDays <= 7 ? 0.55 : 0.35;
      const mentionBoost = Math.min(0.15, Math.max(0, t.mentions - 1) * 0.05);
      topics.push({ tag: t.value, weight: Math.min(0.75, recency + mentionBoost), source: "session", sourceRef: t.lastSeenAt.toISOString() });
    }
  } catch (err) {
    log.warn("buildInterestGraph: failed to load pinned topics:", (err as Error).message);
  }

  // 2. Skills from exec_skills (proficient/expert or flow-state)
  try {
    const { db } = await import("./db");
    const { execSkills } = await import("@shared/schema");
    const { or, eq } = await import("drizzle-orm");
    const skills = await db.select().from(execSkills).where(
      or(eq(execSkills.proficiency, "proficient"), eq(execSkills.proficiency, "expert"), eq(execSkills.energyLevel, "flow"))
    );
    for (const skill of skills) {
      topics.push({ tag: skill.name, weight: 0.8, source: "skill", sourceRef: String(skill.id) });
    }
  } catch (err) {
    log.warn("buildInterestGraph: failed to load skills:", (err as Error).message);
  }

  // 3. Active thesis tags
  try {
    const { thesisStorage } = await import("./thesis-storage");
    const activeTheses = await thesisStorage.list({ status: "active" });
    for (const t of activeTheses) {
      if (t.tags && t.tags.length > 0) {
        for (const tag of t.tags) {
          topics.push({ tag, weight: 0.7, source: "thesis", sourceRef: t.id });
        }
      }
      // Also use thesis title keywords
      const titleWords = t.title.split(/\s+/).filter(w => w.length > 3);
      for (const word of titleWords.slice(0, 3)) {
        topics.push({ tag: word.toLowerCase(), weight: 0.6, source: "thesis", sourceRef: t.id });
      }
    }
  } catch (err) {
    log.warn("buildInterestGraph: failed to load theses:", (err as Error).message);
  }

  // 4. Active goal short names
  try {
    const { goalsService } = await import("./goals-service");
    const goals = await goalsService.listAll();
    for (const g of goals) {
      if (g.status !== "active" && g.status !== "on_track") continue;
      if (g.shortName) {
        const words = g.shortName.split(/\s+/).filter((w: string) => w.length > 3);
        for (const word of words.slice(0, 2)) {
          topics.push({ tag: word.toLowerCase(), weight: 0.6, source: "goal", sourceRef: g.id });
        }
      }
    }
  } catch (err) {
    log.warn("buildInterestGraph: failed to load goals:", (err as Error).message);
  }

  // Dedupe topics by tag (keep highest weight)
  const tagMap = new Map<string, InterestTopic>();
  for (const t of topics) {
    const key = t.tag.toLowerCase();
    const existing = tagMap.get(key);
    if (!existing || t.weight > existing.weight) {
      tagMap.set(key, t);
    }
  }

  // Cap pinned/core interests plus recent session context, sorted by weight descending.
  const deduped = Array.from(tagMap.values());
  deduped.sort((a, b) => b.weight - a.weight);
  return deduped.slice(0, 60);
}

// ── Generate search queries from interest graph ────────────────────
const DISCOVERY_QUERY_PACK = [
  "AI product launch OR model release OR preview",
  "AR glasses OR spatial computing launch",
  "startup funding AI OR spatial computing",
  "developer tool launch AI",
  "new platform API AI",
  "OpenAI OR Anthropic OR Google DeepMind OR Meta AI",
  "frontier model OR reasoning model preview",
  "augmented reality hardware announcement",
];

export function generateDiscoveryQueries(topics: InterestTopic[], maxQueries: number = 8): string[] {
  const highSignalTopics = topics
    .filter(t => t.weight >= 0.75)
    .slice(0, 4)
    .map(t => t.tag);
  const queries = [...DISCOVERY_QUERY_PACK, ...highSignalTopics.map(t => `${t} announcement OR launch OR funding`)];
  return [...new Set(queries)].slice(0, maxQueries);
}

export function generateSearchQueries(topics: InterestTopic[], maxQueries: number = 10): string[] {
  const sorted = [...topics].sort((a, b) => b.weight - a.weight);
  const queries: string[] = [];

  // First pass: high-weight topics (>= 0.8) get standalone queries
  for (const t of sorted) {
    if (t.weight >= 0.8 && queries.length < maxQueries) {
      queries.push(t.tag);
    }
  }

  // Second pass: combine remaining into OR queries for broader coverage
  const remaining = sorted.filter(t => !queries.includes(t.tag));
  for (let i = 0; i < remaining.length && queries.length < maxQueries; i += 2) {
    const pair = remaining.slice(i, i + 2);
    if (pair.length === 2) {
      queries.push(`${pair[0].tag} OR ${pair[1].tag}`);
    } else if (pair.length === 1) {
      queries.push(pair[0].tag);
    }
  }

  return queries.slice(0, maxQueries);
}

// ── Relevance Scorer ───────────────────────────────────────────────

export function scoreSignalRelevance(
  signal: RawSignal,
  interestGraph: InterestTopic[],
  skillNames: string[],
  thesisData: Array<{ id: string; tags: string[]; title: string }>
): ScoredSignal {
  const signalText = `${signal.title} ${signal.snippet}`.toLowerCase();
  const relevanceTags: string[] = [];
  const matchingSkills: string[] = [];
  const matchingTheses: string[] = [];

  // 1. Topic match (0-0.5): keyword overlap with interest graph
  let topicScore = 0;
  for (const topic of interestGraph) {
    const tag = topic.tag.toLowerCase();
    if (signalText.includes(tag)) {
      topicScore += topic.weight * 0.1;
      relevanceTags.push(topic.tag);
    }
  }
  topicScore = Math.min(topicScore, 0.5);

  // 2. Skill match (0-0.3): full skill name match only (no single-word substring)
  // skillNames should already be filtered to applied/domain types by the caller
  let skillScore = 0;
  for (const skill of skillNames) {
    const skillLower = skill.toLowerCase();
    if (signalText.includes(skillLower)) {
      skillScore += 0.15;
      matchingSkills.push(skill);
    }
  }
  skillScore = Math.min(skillScore, 0.3);

  // 3. Thesis match (0-0.2): tag overlap with active theses
  let thesisScore = 0;
  for (const thesis of thesisData) {
    const thesisTags = thesis.tags.map(t => t.toLowerCase());
    const titleWords = thesis.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const allTerms = [...thesisTags, ...titleWords];
    const matched = allTerms.some(term => signalText.includes(term));
    if (matched) {
      thesisScore += 0.1;
      matchingTheses.push(thesis.id);
    }
  }
  thesisScore = Math.min(thesisScore, 0.2);

  const relevanceScore = Math.round((topicScore + skillScore + thesisScore) * 100) / 100;

  return {
    ...signal,
    relevanceScore,
    relevanceTags: [...new Set(relevanceTags)],
    matchingSkills: [...new Set(matchingSkills)],
    matchingTheses: [...new Set(matchingTheses)],
  };
}

// ── Default fallback topics ────────────────────────────────────────
export const DEFAULT_TOPICS = ["AI trends", "tech jobs", "income opportunities"];


// ── Article Reading + Agent Curation ───────────────────────────────

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'");
}

function cleanHumanText(text: string, maxChars?: number): string {
  let cleaned = text;
  for (let i = 0; i < 3; i += 1) {
    const decoded = decodeHtmlEntities(cleaned);
    if (decoded === cleaned) break;
    cleaned = decoded;
  }
  cleaned = cleaned
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return typeof maxChars === "number" ? cleaned.slice(0, maxChars).trim() : cleaned;
}

function stripHtml(html: string): string {
  return cleanHumanText(html);
}

export async function fetchReadableArticleText(url: string, maxChars: number = 6000): Promise<{ text: string; status: "read" | "snippet_only" | "failed" }> {
  if (!/^https?:\/\//i.test(url)) return { text: "", status: "failed" };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      headers: { "User-Agent": BROWSER_USER_AGENT, "Accept": "text/html, text/plain, application/xhtml+xml" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return { text: "", status: "failed" };
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("xml")) {
      return { text: "", status: "failed" };
    }
    const raw = await response.text();
    const text = stripHtml(raw).slice(0, maxChars);
    return text.length >= 200 ? { text, status: "read" } : { text, status: "failed" };
  } catch (err) {
    log.debug(`fetchReadableArticleText failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return { text: "", status: "failed" };
  }
}

function safeJsonObject(content: string): any | null {
  try { return JSON.parse(content); } catch {}
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function fallbackCuratedTitle(_signal: ScoredSignal): string | null {
  return null;
}

export async function curateSignalCandidate(signal: ScoredSignal, interestGraph: InterestTopic[]): Promise<CuratedSignal> {
  const readable = await fetchReadableArticleText(signal.url);
  const articleText = readable.text || signal.snippet || signal.title;
  const topicContext = interestGraph
    .slice(0, 60)
    .map(t => `${t.tag} (${t.source}, weight ${t.weight.toFixed(2)})`)
    .join("; ");

  try {
    const { chatCompletion } = await import("./model-client");
    const result = await chatCompletion({
      activity: ACTIVITY_FRAMING,
      metadata: { source: "landscape-curation", activity: ACTIVITY_FRAMING },
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 500,
      messages: [
        { role: "system", content: "You curate Ray's News Surface. Judge whether a candidate is concretely relevant to pinned interests or recent work. Topics can match literally or conceptually. For broad topics like Innovation, look for real novelty: new capability, interface, technical primitive, business model, funding, adoption, or ecosystem shift. The display title must be a compact label, not a headline rewrite: 2-4 words, Title Case, no question phrases, no article-style wording, no filler like 'What is', 'How to', 'Guide to', 'The future of'. Good examples: New AR Hardware, Competitor Funded, Harness Innovation, Spatial Workflow. Bad examples: What Is a Meta-Harness, This Startup Is Building, How AI Avatars Work. If you cannot name the relevance cleanly, set isRelevant=false. Return strict JSON only." },
        { role: "user", content: JSON.stringify({
          topics: topicContext,
          candidate: {
            sourceType: signal.sourceType,
            title: signal.title,
            url: signal.url,
            snippet: signal.snippet,
            articleText: articleText.slice(0, 6000),
            heuristicScore: signal.relevanceScore,
            heuristicTags: signal.relevanceTags,
          },
          output: {
            isRelevant: "boolean",
            score: "0..1",
            title: "2-4 word Title Case relevance label, not the original headline and not a sentence",
            reason: "one short sentence explaining why Ray should care; plain text only, no HTML or escaped HTML",
            matchedTopics: "array of topic strings",
            summary: "optional one short sentence factual summary; plain text only, no HTML or escaped HTML",
          },
        }) },
      ],
    });
    const parsed = safeJsonObject(result.content);
    const score = Math.max(0, Math.min(1, Number(parsed?.score ?? 0)));
    const isRelevant = Boolean(parsed?.isRelevant) && score >= 0.45;
    const rawTitle = typeof parsed?.title === "string" ? parsed.title.trim() : "";
    const bannedTitlePattern = /^(what|how|why|when|where|guide|the future|this|these|a |an |the )\b/i;
    const title = rawTitle && rawTitle.split(/\s+/).length <= 4 && !bannedTitlePattern.test(rawTitle) ? rawTitle : fallbackCuratedTitle(signal);
    const reason = typeof parsed?.reason === "string" ? cleanHumanText(parsed.reason, 240) : "";
    return {
      ...signal,
      relevanceScore: Math.max(signal.relevanceScore, score),
      curatedTitle: isRelevant && reason ? title : null,
      curatedReason: isRelevant && reason ? reason : null,
      curationStatus: readable.status === "read" ? "read" : "snippet_only",
      curationScore: score,
      matchedTopics: Array.isArray(parsed?.matchedTopics) ? parsed.matchedTopics.filter((t: unknown) => typeof t === "string").slice(0, 8) : signal.relevanceTags,
      agentSummary: typeof parsed?.summary === "string" ? cleanHumanText(parsed.summary, 300) : null,
    };
  } catch (err) {
    log.warn(`curateSignalCandidate failed for ${signal.url}: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ...signal,
      curatedTitle: null,
      curatedReason: null,
      curationStatus: readable.status === "read" ? "failed" : "snippet_only",
      curationScore: null,
      matchedTopics: signal.relevanceTags,
      agentSummary: null,
    };
  }
}

// ── YouTube Channel Scanner ────────────────────────────────────────

const YOUTUBE_RSS_BASE = "https://www.youtube.com/feeds/videos.xml";

export async function scanYouTubeChannelSources(sources: Array<{ id: string; value: string }>): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const source of sources) {
    try {
      const channelId = source.value.trim();
      if (!channelId) continue;

      const url = `${YOUTUBE_RSS_BASE}?channel_id=${encodeURIComponent(channelId)}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": BROWSER_USER_AGENT },
        });

        if (!response.ok) {
          log.debug(`scanYouTubeChannelSources: HTTP ${response.status} for channel "${channelId}"`);
          continue;
        }

        const xml = await response.text();
        const items = parseRssItems(xml);
        let count = 0;

        for (const item of items) {
          if (!item.title || !item.link) continue;

          // Filter to last 7 days
          if (item.pubDate) {
            const pubTime = new Date(item.pubDate).getTime();
            if (!isNaN(pubTime) && pubTime < sevenDaysAgo) continue;
          }

          // Extract video ID from link if possible
          const videoIdMatch = item.link.match(/watch\?v=([^&]+)/);
          const videoId = videoIdMatch?.[1];
          const videoUrl = videoId
            ? `https://www.youtube.com/watch?v=${videoId}`
            : item.link;

          allSignals.push({
            sourceType: "youtube",
            sourceId: source.id,
            title: item.title,
            url: videoUrl,
            snippet: (item.description || "").slice(0, 500),
            publishedAt: item.pubDate || null,
            rawMetadata: {
              channelId,
              videoId: videoId || null,
            },
          });
          count++;
        }
        log.log(`scanYouTubeChannelSources: channel "${channelId}" returned ${count} recent videos`);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      log.warn(`scanYouTubeChannelSources: error scanning "${source.value}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return allSignals;
}
