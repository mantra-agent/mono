import { createLogger } from "./log";

const log = createLogger("UrlRouter");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouterResult {
  content: string;
  source: string;
}

interface RouteEntry {
  test: RegExp;
  handler: (url: string) => Promise<RouterResult>;
  name: string;
}

// ---------------------------------------------------------------------------
// Pattern table — order matters: most specific first
// ---------------------------------------------------------------------------

const ROUTE_TABLE: RouteEntry[] = [
  {
    test: /^https?:\/\/(x\.com|twitter\.com)\//i,
    handler: fetchTwitterContent,
    name: "fxtwitter",
  },
  {
    test: /^https?:\/\/(www\.)?(old\.)?reddit\.com\//i,
    handler: fetchRedditContent,
    name: "reddit_json",
  },
  {
    test: /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i,
    handler: fetchYouTubeTranscript,
    name: "youtube_transcript",
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to route a URL through a domain-specific extractor.
 * Returns RouterResult on success, null if no match or handler failed.
 */
export async function routeUrl(url: string): Promise<RouterResult | null> {
  const normalized = normalizeUrl(url);

  for (const route of ROUTE_TABLE) {
    if (!route.test.test(normalized)) continue;

    log.log(`routeUrl: matched ${route.name} for ${normalized}`);
    try {
      const result = await route.handler(normalized);
      log.log(
        `routeUrl: ${route.name} returned ${result.content.length} chars for ${normalized}`
      );
      return result;
    } catch (err: any) {
      log.warn(
        `routeUrl: ${route.name} failed for ${normalized}: ${err.message}`
      );
      return null;
    }
  }

  return null;
}

/**
 * Fetch content via Jina Reader — JS-rendering proxy.
 * Exported separately for use as a fallback in web_fetch's JS-wall detection.
 */
export async function fetchViaJinaReader(
  url: string
): Promise<RouterResult | null> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  log.log(`fetchViaJinaReader: fetching ${url}`);

  try {
    const response = await fetch(jinaUrl, {
      headers: { Accept: "text/markdown" },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      log.warn(`fetchViaJinaReader: ${response.status} for ${url}`);
      return null;
    }

    const text = await response.text();
    if (!text || text.trim().length < 50) {
      log.warn(`fetchViaJinaReader: empty/tiny response for ${url}`);
      return null;
    }

    log.log(
      `fetchViaJinaReader: returned ${text.length} chars for ${url}`
    );
    return { content: text, source: "Jina Reader" };
  } catch (err: any) {
    log.warn(`fetchViaJinaReader: failed for ${url}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
  let u = url.trim();
  // Normalize mobile domains
  u = u.replace(/^(https?:\/\/)m\.reddit\.com/i, "$1www.reddit.com");
  u = u.replace(
    /^(https?:\/\/)mobile\.twitter\.com/i,
    "$1twitter.com"
  );
  return u;
}

// ---------------------------------------------------------------------------
// X / Twitter handler via FxTwitter API
// ---------------------------------------------------------------------------

const TWEET_URL_RE =
  /^https?:\/\/(x\.com|twitter\.com)\/([^/]+)\/status\/(\d+)/i;

async function fetchTwitterContent(url: string): Promise<RouterResult> {
  const match = url.match(TWEET_URL_RE);
  if (!match) {
    // Could be x.com/i/article/{id} or other non-tweet URL — fall through
    throw new Error("URL is not a tweet status URL, skipping FxTwitter");
  }

  const screenName = match[2];
  const tweetId = match[3];
  const apiUrl = `https://api.fxtwitter.com/${screenName}/status/${tweetId}`;

  const response = await fetch(apiUrl, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`FxTwitter API returned ${response.status}`);
  }

  const data = await response.json();
  const tweet = data?.tweet;
  if (!tweet) {
    throw new Error("FxTwitter response missing tweet object");
  }

  return {
    content: formatTweetMarkdown(tweet),
    source: "FxTwitter API",
  };
}

function formatTweetMarkdown(tweet: any): string {
  const author = tweet.author || {};
  const lines: string[] = [];

  // Title — article title or tweet attribution
  if (tweet.article?.title) {
    lines.push(`# ${tweet.article.title}`);
  } else {
    lines.push(`# Tweet by @${author.screen_name || "unknown"}`);
  }

  lines.push("");
  lines.push(
    `**@${author.screen_name || "unknown"}** (${author.name || ""}) · ${tweet.created_at || ""}`
  );
  if (author.followers != null) {
    lines.push(`${Number(author.followers).toLocaleString()} followers`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // Body — article text takes priority, then tweet text
  if (tweet.article?.text) {
    lines.push(tweet.article.text);
  } else {
    lines.push(tweet.text || "");
  }

  // Media
  if (tweet.media?.all?.length) {
    lines.push("");
    lines.push("**Media:**");
    for (const m of tweet.media.all) {
      if (m.type === "photo") {
        lines.push(`- ![image](${m.url})`);
      } else if (m.type === "video" || m.type === "gif") {
        lines.push(`- [${m.type}](${m.url})`);
      }
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");

  // Engagement stats
  const stats: string[] = [];
  if (tweet.likes != null) stats.push(`❤️ ${Number(tweet.likes).toLocaleString()}`);
  if (tweet.retweets != null) stats.push(`🔄 ${Number(tweet.retweets).toLocaleString()}`);
  if (tweet.replies != null) stats.push(`💬 ${Number(tweet.replies).toLocaleString()}`);
  if (tweet.views != null) stats.push(`👁️ ${Number(tweet.views).toLocaleString()}`);
  if (stats.length) lines.push(stats.join(" · "));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reddit handler via .json suffix
// ---------------------------------------------------------------------------

async function fetchRedditContent(url: string): Promise<RouterResult> {
  // Strip trailing slash and query, append .json
  let jsonUrl = url.replace(/\/?(\?.*)?$/, ".json");
  // If URL already ends in .json.json, fix it
  jsonUrl = jsonUrl.replace(/\.json\.json$/, ".json");

  const response = await fetch(jsonUrl, {
    headers: {
      "User-Agent": "Mantra/1.0 (content research bot)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Reddit .json returned ${response.status}`);
  }

  const data = await response.json();

  // Reddit returns an array of Listing objects
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Reddit response is not a listing array");
  }

  const post = data[0]?.data?.children?.[0]?.data;
  if (!post) {
    throw new Error("Reddit response missing post data");
  }

  const comments =
    data[1]?.data?.children
      ?.filter((c: any) => c.kind === "t1" && c.data?.body)
      ?.slice(0, 10) || [];

  return {
    content: formatRedditMarkdown(post, comments),
    source: "Reddit .json",
  };
}

function formatRedditMarkdown(post: any, comments: any[]): string {
  const lines: string[] = [];

  lines.push(`# ${post.title || "Untitled"}`);
  lines.push("");
  lines.push(
    `**r/${post.subreddit || "unknown"}** · u/${post.author || "deleted"} · ${post.score ?? 0} points · ${post.num_comments ?? 0} comments`
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  if (post.selftext) {
    lines.push(post.selftext);
  } else if (post.url && !post.is_self) {
    lines.push(`[Link post: ${post.url}]`);
  }

  if (comments.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## Top Comments");
    lines.push("");

    for (const c of comments) {
      const cd = c.data;
      lines.push(
        `**u/${cd.author || "deleted"}** (${cd.score ?? 0} points):`
      );
      lines.push(cd.body);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// YouTube handler via youtube-transcript
// ---------------------------------------------------------------------------

const YOUTUBE_ID_RE =
  /(?:youtube\.com\/(?:watch\?.*v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;

async function fetchYouTubeTranscript(url: string): Promise<RouterResult> {
  const match = url.match(YOUTUBE_ID_RE);
  if (!match) {
    throw new Error("Could not extract YouTube video ID from URL");
  }

  const videoId = match[1];

  const { fetchTranscript } = await import("youtube-transcript");
  const segments = await fetchTranscript(videoId);

  if (!segments || segments.length === 0) {
    throw new Error("No transcript segments returned");
  }

  // Group segments into ~30-second paragraphs for readability
  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];
  let paragraphStart = segments[0].offset;

  for (const seg of segments) {
    if (seg.offset - paragraphStart > 30_000 && currentParagraph.length > 0) {
      paragraphs.push(currentParagraph.join(" "));
      currentParagraph = [];
      paragraphStart = seg.offset;
    }
    currentParagraph.push(seg.text.trim());
  }
  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph.join(" "));
  }

  const lines: string[] = [];
  lines.push("# YouTube Transcript");
  lines.push("");
  lines.push(`**Video:** https://youtube.com/watch?v=${videoId}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(paragraphs.join("\n\n"));

  return {
    content: lines.join("\n"),
    source: "youtube-transcript",
  };
}

// ---------------------------------------------------------------------------
// JS-wall detection (exported for use in bridge-tools)
// ---------------------------------------------------------------------------

export function isJsWallPage(body: string): boolean {
  return (
    /javascript is not available|enable javascript|requires javascript/i.test(
      body
    ) && body.length < 5000
  );
}
