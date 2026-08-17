import { readFile } from "fs/promises";
import { objectStorageService } from "../../object_storage";
import { getSecretSync } from "../../secrets-store";
import { createLogger } from "../../log";
import {
  inputFailure,
  transientFailure,
  type ToolFailure,
} from "../../tool-failure";
import type { ToolHandler } from "../contracts";
import { contractReject } from "../shared/failures";

const toolExec = createLogger("ToolExec");

/** Classify HTTP status from web.fetch non-ok responses. */
function classifyWebFetchHttpStatus(status: number): ToolFailure {
  if (status === 408 || status === 429 || status >= 500) {
    return transientFailure("web_fetch_transient", `http_${status}`);
  }
  return inputFailure("web_fetch_http_error", `http_${status}`);
}

/** Classify thrown web.fetch errors (timeouts / network). */
function classifyWebFetchThrownError(err: unknown): ToolFailure | undefined {
  if (!err || typeof err !== "object") return undefined;
  const name = (err as { name?: unknown }).name;
  if (name === "AbortError") {
    return transientFailure("web_fetch_timeout");
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/timed?\s*out|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(message)) {
    return transientFailure("web_fetch_transient", message.slice(0, 120));
  }
  return undefined;
}

function stripHtml(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]*(?:display\s*:\s*none|pointer-events-none|opacity-0|aria-hidden\s*=\s*"true")[^>]*>[\s\S]*?<\/[^>]+>/gi, "")
    .replace(/<[^>]*\bclass\s*=\s*"[^"]*\bhidden\b[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, "")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|blockquote|details|summary|figcaption|figure|pre|dd|dt)>/gi, "\n")
    .replace(/<(?:p|div|h[1-6]|ul|ol|section|article|blockquote|details|table|pre)[\s>]/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#\d+;/g, "");

  text = text
    .replace(/<\/?(?:strong|em|b|i|u|span|a|mark|small|sub|sup|code|abbr|cite|q|s|del|ins|kbd|var|samp|bdi|bdo|wbr|ruby|rt|rp|data|time|dfn)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ");

  text = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/^ +| +$/gm, "");

  const lines = text.split("\n");
  const cleaned = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^(?:class|style|id|data-|aria-|role|tabindex|onclick|href)\s*=/.test(trimmed)) return false;
    if (/^[a-z-]+\s*:\s*[^;]+;\s*$/i.test(trimmed) && trimmed.length < 80) return false;
    if (/^[{}()\[\]<>]+$/.test(trimmed)) return false;
    if (/^(?:var|const|let|function|return|if|else|for|while)\s/.test(trimmed)) return false;
    return true;
  });

  return cleaned.join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Web search, fetch, and screenshot/test handlers. */
export const webTools: Record<string, ToolHandler> = {
  async web_search(args) {
    const query = args.query;
    if (!query) return { result: "Missing search query", error: true };

    const apiKey = getSecretSync("BRAVE_API_KEY") || getSecretSync("BRAVE_SEARCH_API_KEY");
    if (!apiKey) return { result: "Brave Search API key not configured (BRAVE_API_KEY)", error: true };

    try {
      const count = args.count || 10;
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
      const searchController = new AbortController();
      const searchTimeout = setTimeout(() => searchController.abort(), 15000);
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: searchController.signal,
      });
      clearTimeout(searchTimeout);

      if (!response.ok) {
        return { result: `Brave Search error: ${response.status} ${response.statusText}`, error: true };
      }

      const data = await response.json() as any;
      const results = (data.web?.results || []).slice(0, count);

      if (results.length === 0) return { result: `No results for "${query}"` };

      const lines = results.map((r: any, i: number) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description || ""}`
      );
      return { result: `Search results for "${query}":\n\n${lines.join("\n\n")}` };
    } catch (err: any) {
      return { result: `Web search error: ${err.message}`, error: true };
    }
  },

  async web_fetch(args) {
    const url = args.url;
    if (!url) {
      return contractReject("Missing URL", "web_input_invalid");
    }

    try {
      const { assertSafeUntrustedHttpUrl, fetchUntrustedUrl } = await import("../../untrusted-url");
      await assertSafeUntrustedHttpUrl(url);
      // --- Smart URL Router: try domain-specific extraction first ---
      const { routeUrl } = await import("../../url-routers");
      const routed = await routeUrl(url);
      if (routed) {
        const note = `[Fetched via ${routed.source}]\n\n`;
        const WEB_FETCH_SUMMARIZE_THRESHOLD = 10_000;
        if (routed.content.length <= WEB_FETCH_SUMMARIZE_THRESHOLD) {
          return { result: `${note}${routed.content}` };
        }
        const { indexAndArchiveWithFallback } = await import("../../content-indexer");
        try {
          const refBlock = await indexAndArchiveWithFallback({
            content: routed.content,
            sourceType: "web_fetch",
            sourceLabel: url,
          });
          toolExec.log(`web_fetch: indexed ${routed.content.length} chars from ${routed.source} for ${url}`);
          return { result: `${note}${refBlock}` };
        } catch (indexErr: any) {
          toolExec.warn(`web_fetch: indexing routed content failed: ${indexErr.message}`);
          const { heuristicFallbackWithArchive } = await import("../../content-indexer");
          const fallback = heuristicFallbackWithArchive(routed.content, indexErr.message);
          return { result: `${note}${fallback}` };
        }
      }
      // --- End Smart URL Router ---

      const REALISTIC_HEADERS: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      };

      const controller = new AbortController();
      const fetchTimer = setTimeout(() => controller.abort(), args.timeout || 15000);

      let response: Response;
      try {
        response = await fetchUntrustedUrl(url, {
          signal: controller.signal,
          headers: REALISTIC_HEADERS,
        });
      } finally {
        clearTimeout(fetchTimer);
      }

      const isBlockDetected = (status: number, body: string): boolean => {
        if (status === 403 || status === 429) return true;
        if (status === 503 && /cloudflare|challenge/i.test(body)) return true;
        const trimmed = body.trim();
        if (trimmed.length === 0 && status >= 400) return true;
        if (trimmed.length < 500 && /access denied|blocked|forbidden/i.test(trimmed)) return true;
        if (/cf-browser-verification|cf-challenge|akamai.*bot/i.test(body)) return true;
        return false;
      };

      const isBlockPage = (body: string): boolean => {
        const trimmed = body.trim();
        if (trimmed.length === 0) return true;
        if (trimmed.length < 500 && /access denied|blocked|forbidden/i.test(trimmed)) return true;
        if (/cf-browser-verification|cf-challenge|akamai.*bot/i.test(body)) return true;
        return false;
      };

      const MAX_BROWSER_TIMEOUT_MS = 30_000;

      let rawText: string;
      let usedBrowser = false;
      let browserWarmUp = false;

      const retryWithBrowser = async (reason: string): Promise<string> => {
        toolExec.log(`web_fetch: ${reason} for ${url}, retrying with headless browser`);
        const browserMgr = await import("../../browser-manager");
        const needsLaunch = !browserMgr.isBrowserReady();
        if (needsLaunch) {
          toolExec.log("web_fetch: browser is being launched for this fetch, this may take a moment...");
          browserWarmUp = true;
        }
        const browserTimeout = Math.min(args.timeout || MAX_BROWSER_TIMEOUT_MS, MAX_BROWSER_TIMEOUT_MS);
        const html = await browserMgr.fetchWithBrowser(url, browserTimeout);
        usedBrowser = true;
        return stripHtml(html);
      };

      if (!response.ok) {
        const bodySnippet = await response.text().catch(() => "");
        if (isBlockDetected(response.status, bodySnippet)) {
          rawText = await retryWithBrowser(`blocked by ${response.status}`);
        } else {
          return {
            result: `Fetch error: ${response.status} ${response.statusText}`,
            error: true,
            failure: classifyWebFetchHttpStatus(response.status),
          };
        }
      } else {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const json = await response.json();
          rawText = JSON.stringify(json, null, 2);
        } else {
          const bodyText = await response.text();
          if (isBlockPage(bodyText)) {
            rawText = await retryWithBrowser("block page detected in body");
          } else {
            const stripped = stripHtml(bodyText);
            // JS-wall detection: try Jina Reader before browser fallback
            const { isJsWallPage } = await import("../../url-routers");
            if (isJsWallPage(bodyText) || (stripped.trim().length < 200 && isJsWallPage(bodyText + stripped))) {
              toolExec.log(`web_fetch: JS-wall detected for ${url}, trying Jina Reader`);
              const { fetchViaJinaReader } = await import("../../url-routers");
              const jinaResult = await fetchViaJinaReader(url);
              if (jinaResult) {
                const note = `[Fetched via ${jinaResult.source}]\n\n`;
                const WEB_FETCH_SUMMARIZE_THRESHOLD = 10_000;
                if (jinaResult.content.length <= WEB_FETCH_SUMMARIZE_THRESHOLD) {
                  return { result: `${note}${jinaResult.content}` };
                }
                const { indexAndArchiveWithFallback } = await import("../../content-indexer");
                const refBlock = await indexAndArchiveWithFallback({
                  content: jinaResult.content,
                  sourceType: "web_fetch",
                  sourceLabel: url,
                });
                return { result: `${note}${refBlock}` };
              }
              // Jina failed — fall through to browser
              rawText = await retryWithBrowser("JS-wall and Jina failed");
            } else {
              rawText = stripped;
            }
          }
        }
      }

      if (usedBrowser) {
        toolExec.log(`web_fetch: successfully fetched ${url} via headless browser (${rawText.length} chars)`);
      }

      const browserNote = browserWarmUp
        ? "[Note: headless browser was launched for this fetch — initial launch added a brief delay.]\n\n"
        : usedBrowser
          ? "[Note: content was fetched via headless browser due to bot protection on this site.]\n\n"
          : "";

      const WEB_FETCH_SUMMARIZE_THRESHOLD = 10_000;

      if (rawText.length <= WEB_FETCH_SUMMARIZE_THRESHOLD) {
        return { result: `${browserNote}${rawText}` };
      }

      const { indexAndArchiveWithFallback } = await import("../../content-indexer");

      try {
        const refBlock = await indexAndArchiveWithFallback({
          content: rawText,
          sourceType: "web_fetch",
          sourceLabel: url,
        });

        toolExec.log(`web_fetch: indexed ${rawText.length} chars for ${url}`);
        return { result: `${browserNote}${refBlock}` };
      } catch (indexErr: any) {
        toolExec.warn(`web_fetch: indexing failed, using fallback: ${indexErr.message}`);
        const { heuristicFallbackWithArchive } = await import("../../content-indexer");
        const fallback = heuristicFallbackWithArchive(rawText, indexErr.message);
        return { result: `${browserNote}${fallback}` };
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { result: `Fetch timed out for ${url}`, error: true };
      }
      return {
      result: `Fetch error: ${err.message}`,
      error: true,
      failure: classifyWebFetchThrownError(err),
    };
    }
  },

  async web_test(args) {
    const route = args.route as string | undefined;
    const url = args.url as string | undefined;
    const viewport = args.viewport as string | undefined;
    const fullPage = args.fullPage as boolean | undefined;
    const delay = args.delay as number | undefined;
    const steps = args.steps;
    const auth = args.auth;

    if (!route && !url) {
      return {
        result: "Either 'route' or 'url' is required for test action",
        error: true,
        failure: inputFailure("web_test_input_invalid", "route_or_url_required"),
      };
    }

    let targetUrl: string;
    if (route) {
      const port = process.env.PORT || "5000";
      targetUrl = `http://localhost:${port}${route.startsWith("/") ? route : "/" + route}`;
    } else {
      targetUrl = url!;
    }

    try {
      const { screenshotPage } = await import("../../browser-manager");
      const result = await screenshotPage(targetUrl, {
        viewport,
        fullPage,
        delay,
        steps,
        auth,
      });

      const frameLines: string[] = [];
      for (let i = 0; i < result.frames.length; i++) {
        const frame = result.frames[i];
        try {
          const buffer = await readFile(frame.path);
          const fileName = `screenshot-${frame.label || i}-${Date.now()}.png`;
          const { objectPath } = await objectStorageService.uploadObjectEntity(buffer, {
            extension: ".png",
            contentType: "image/png",
            acl: { owner: "system", visibility: "public" },
          });
          const downloadLink = `${objectPath}?name=${encodeURIComponent(fileName)}`;
          const truncNote = frame.truncated ? " (truncated at 4000px height)" : "";
          frameLines.push(
            `![${frame.label || `frame-${i}`} ${frame.width}×${frame.height}](${downloadLink})\n[Download](${downloadLink})${truncNote}`,
          );
        } catch (persistErr: unknown) {
          const persistMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
          frameLines.push(
            `Frame ${frame.label || i} captured (${frame.width}×${frame.height}) but persist failed: ${persistMsg}. Scratch: ${frame.path}`,
          );
        }
      }

      const stepLines =
        result.steps.length === 0
          ? ["steps: (none)"]
          : result.steps.map(
              (s) =>
                `step ${s.index} ${s.kind}: ${s.status}${s.detail ? ` — ${s.detail}` : ""}`,
            );

      const stanza = [
        `outcome: ${result.outcome}`,
        `auth: ${result.authUsed}`,
        `entry: ${result.entryUrl}`,
        `final: ${result.finalUrl ?? "(none)"}`,
        ...stepLines,
        result.errorMessage ? `error: ${result.errorMessage}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      const body = frameLines.length > 0 ? `${stanza}\n\n${frameLines.join("\n\n")}` : stanza;

      const correctable = new Set([
        "input_invalid",
        "step_failed",
        "origin_escaped",
        "auth_failed",
      ]);
      if (result.outcome === "ok") {
        return { result: body };
      }
      if (correctable.has(result.outcome)) {
        return {
          result: body,
          error: true,
          failure: inputFailure(`web_test_${result.outcome}`, result.errorMessage?.slice(0, 160)),
        };
      }
      return { result: body, error: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `web.test failed: ${msg}`, error: true };
    }
  },
};
// Deprecated alias — backward compat
webTools.web_screenshot = webTools.web_test;
