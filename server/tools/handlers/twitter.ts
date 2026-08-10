import { safeStringify } from "../../utils/safe-stringify";
import type { ToolHandler, ToolHandlerResult } from "../contracts";

/**
 * X (Twitter) handler extracted from bridge-tools.ts. Delegates every action to
 * the canonical twitter integration module and gates posting/replying/deleting
 * on stored per-account permissions. Behavior, result shapes, and error
 * handling are preserved verbatim; public identity (tool-registry),
 * ownership/composition (domain-adapters), and the executeTool
 * invocation/authority boundary remain owned by their canonical modules.
 */
export const twitterHandler: ToolHandler = async (args) => {
  const action = args.action || "status";
  try {
    const twitter = await import("../../twitter");
    const twitterActions: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      status: async () => {
        const connected = await twitter.isTwitterConnected();
        if (!connected) return { result: "X (Twitter) is not connected. The user needs to add their API credentials in Settings → Connections." };
        const accounts = await twitter.listTwitterAccounts();
        const results = [];
        for (const acct of accounts) {
          const check = await twitter.verifyStoredCredentials(acct.id);
          const perms = await twitter.getTwitterPermissions(acct.id);
          results.push({
            id: acct.id,
            label: acct.label,
            valid: check.valid,
            username: check.username,
            error: check.error,
            permissions: perms,
          });
        }
        return { result: safeStringify({ connected: true, accounts: results }, { label: "bridge.accounts.connected" }) };
      },
      post: async (a) => {
        const account = await twitter.getFirstAccountTokens();
        if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
        const allowed = await twitter.checkTwitterPermission(account.accountId, "post");
        if (!allowed) return { result: "Posting is disabled for this X account. The user can enable it in Settings → Connections → X (Twitter) permissions.", error: true };
        if (!a.text) return { result: "Missing tweet text. Provide the 'text' parameter.", error: true };
        const result = await twitter.postTweet(account.tokens, a.text);
        return { result: `Tweet posted successfully!\nURL: ${result.url}\nID: ${result.id}` };
      },
      reply: async (a) => {
        const account = await twitter.getFirstAccountTokens();
        if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
        const allowed = await twitter.checkTwitterPermission(account.accountId, "reply");
        if (!allowed) return { result: "Replying is disabled for this X account. The user can enable it in Settings → Connections → X (Twitter) permissions.", error: true };
        if (!a.tweet_id) return { result: "Missing tweet_id. Provide the tweet ID or URL to reply to.", error: true };
        if (!a.text) return { result: "Missing reply text. Provide the 'text' parameter.", error: true };
        const tweetId = twitter.parseTweetId(a.tweet_id);
        if (!tweetId) return { result: `Could not parse tweet ID from: ${a.tweet_id}`, error: true };
        const result = await twitter.replyToTweet(account.tokens, tweetId, a.text);
        return { result: `Reply posted successfully!\nURL: ${result.url}\nID: ${result.id}` };
      },
      lookup: async (a) => {
        const account = await twitter.getFirstAccountTokens();
        if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
        if (!a.tweet_id) return { result: "Missing tweet_id. Provide a tweet ID or URL to look up.", error: true };
        const articleId = twitter.parseArticleId(a.tweet_id);
        if (articleId && /\/i\/articles\//i.test(a.tweet_id)) {
          if (!account.tokens.bearerToken) return { result: "This is an X Article URL. A Bearer Token is required to read articles. Add one in Settings → Connections → X (Twitter).", error: true };
          const article = await twitter.lookupNews(account.tokens.bearerToken, articleId);
          return { result: JSON.stringify(article) };
        }
        const tweetId = twitter.parseTweetId(a.tweet_id);
        if (!tweetId) return { result: `Could not parse tweet ID from: ${a.tweet_id}`, error: true };
        const tweet = await twitter.lookupTweet(account.tokens, tweetId);
        return { result: JSON.stringify(tweet) };
      },
      delete: async (a) => {
        const account = await twitter.getFirstAccountTokens();
        if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
        const allowed = await twitter.checkTwitterPermission(account.accountId, "delete");
        if (!allowed) return { result: "Deleting tweets is disabled for this X account. The user can enable it in Settings → Connections → X (Twitter) permissions.", error: true };
        if (!a.tweet_id) return { result: "Missing tweet_id. Provide the tweet ID or URL to delete.", error: true };
        const tweetId = twitter.parseTweetId(a.tweet_id);
        if (!tweetId) return { result: `Could not parse tweet ID from: ${a.tweet_id}`, error: true };
        await twitter.deleteTweet(account.tokens, tweetId);
        return { result: `Tweet ${tweetId} deleted successfully.` };
      },
      news_search: async (a) => {
        const account = await twitter.getFirstAccountTokens();
        if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
        if (!account.tokens.bearerToken) return { result: "No Bearer Token configured for this X account. Add a Bearer Token in Settings → Connections → X (Twitter) to use news/article endpoints.", error: true };
        if (!a.query) return { result: "Missing query. Provide a search query for news articles.", error: true };
        let maxResults: number | undefined;
        if (a.max_results) {
          maxResults = parseInt(a.max_results, 10);
          if (isNaN(maxResults) || maxResults < 1 || maxResults > 100) {
            return { result: "max_results must be a number between 1 and 100.", error: true };
          }
        }
        const results = await twitter.searchNews(account.tokens.bearerToken, a.query, maxResults);
        return { result: JSON.stringify(results) };
      },
      news_lookup: async (a) => {
        const account = await twitter.getFirstAccountTokens();
        if (!account) return { result: "No X (Twitter) account connected. Add credentials in Settings → Connections.", error: true };
        if (!account.tokens.bearerToken) return { result: "No Bearer Token configured for this X account. Add a Bearer Token in Settings → Connections → X (Twitter) to use news/article endpoints.", error: true };
        if (!a.article_id) return { result: "Missing article_id. Provide an article ID or URL to look up.", error: true };
        const articleId = twitter.parseArticleId(a.article_id);
        if (!articleId) return { result: `Could not parse article ID from: ${a.article_id}`, error: true };
        const article = await twitter.lookupNews(account.tokens.bearerToken, articleId);
        return { result: JSON.stringify(article) };
      },
    };

    const handler = twitterActions[action];
    if (!handler) return { result: `Unknown twitter action: ${action}. Available: status, post, reply, lookup, delete, news_search, news_lookup`, error: true };
    return await handler(args);
  } catch (err: any) {
    return { result: `Twitter tool error: ${err.message}`, error: true };
  }
};
