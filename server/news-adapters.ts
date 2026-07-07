import { createLogger } from "./log";
import { getSecretSync } from "./secrets-store";
import { createHash } from "crypto";
import { ACTIVITY_FRAMING } from "./job-profiles";

const log = createLogger("LandscapeAdapters");

// ── Types ──────────────────────────────────────────────────────────
const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export interface RawSignal {
  sourceType: "x" | "x_account" | "web" | "reddit" | "rss";
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

export async function scanRedditSources(subreddits: Array<{ id: string; value: string }>): Promise<RawSignal[]> {
  const signals: RawSignal[] = [];
  for (const source of subreddits) {
    try {
      const subreddit = source.value.replace(/^\/?(r\/)?/, "");
      const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=25`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      // Rate limit: space requests 2s apart to avoid 429
      if (signals.length > 0) await new Promise(r => setTimeout(r, 2000));
      const response = await fetch(url, {
        headers: { "User-Agent": BROWSER_USER_AGENT },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        log.warn(`scanRedditSources: HTTP ${response.status} for r/${subreddit}`);
        continue;
      }

      const data = await response.json() as any;
      const posts = data?.data?.children || [];
      for (const child of posts) {
        const post = child?.data;
        if (!post || post.stickied) continue;
        const postUrl = post.url_overridden_by_dest || `https://www.reddit.com${post.permalink}`;
        signals.push({
          sourceType: "reddit",
          sourceId: source.id,
          title: post.title || "",
          url: postUrl,
          snippet: cleanHumanText(post.selftext || "", 500),
          publishedAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
          rawMetadata: { subreddit, score: post.score, numComments: post.num_comments },
        });
      }
      log.log(`scanRedditSources: r/${subreddit} returned ${posts.length} posts`);
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
