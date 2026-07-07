import { createLogger } from "./log";
import {
  claimContentForPublish,
  resetStalePublishing,
  updateContent,
  getScheduledPostsInRange,
  type ContentQueue,
} from "./content-storage";
import { listGmailAccounts } from "./gmail";

const log = createLogger("ContentPublisher");

export async function publishScheduledContent(): Promise<void> {
  await resetStalePublishing();

  const posts = await claimContentForPublish();
  if (posts.length === 0) {
    log.log(`No posts due for publishing`);
    return;
  }

  log.log(`Claimed ${posts.length} posts for publishing`);

  for (const post of posts) {
    try {
      await publishSinglePost(post);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to publish post ${post.id}: ${message}`);
      const newRetryCount = post.retryCount + 1;
      if (newRetryCount >= 3) {
        await updateContent(post.id, {
          status: "failed",
          retryCount: newRetryCount,
          metadata: { ...(post.metadata as Record<string, unknown> || {}), lastError: message },
        });
        log.error(`Post ${post.id} marked as failed after ${newRetryCount} retries`);
      } else {
        await updateContent(post.id, {
          status: "scheduled",
          retryCount: newRetryCount,
          metadata: { ...(post.metadata as Record<string, unknown> || {}), lastError: message },
        });
        log.log(`Post ${post.id} retry ${newRetryCount}/3, back to scheduled`);
      }
    }
  }
}

async function publishSinglePost(post: ContentQueue): Promise<void> {
  const twitter = await import("./twitter");
  const account = await twitter.getFirstAccountTokens();
  if (!account) {
    throw new Error("Twitter not connected — no account tokens available");
  }

  const allowed = await twitter.checkTwitterPermission(account.accountId, "post");
  if (!allowed) {
    throw new Error("Posting is disabled for this X account");
  }

  let result: { id: string; url: string; text: string };

  if (post.threadParts && Array.isArray(post.threadParts) && post.threadParts.length > 1) {
    const firstResult = await twitter.postTweet(account.tokens, post.threadParts[0]);
    let lastId = firstResult.id;
    let lastUrl = firstResult.url;

    for (let i = 1; i < post.threadParts.length; i++) {
      const replyResult = await twitter.replyToTweet(account.tokens, lastId, post.threadParts[i]);
      lastId = replyResult.id;
      lastUrl = replyResult.url;
    }

    result = { id: firstResult.id, url: firstResult.url, text: post.threadParts[0] };
  } else {
    result = await twitter.postTweet(account.tokens, post.content);
  }

  await updateContent(post.id, {
    status: "published",
    platformPostId: result.id,
    platformUrl: result.url,
    publishedAt: new Date(),
  });

  log.log(`Published post ${post.id} → ${result.url}`);

  try {
    await updateContentCalendarEvent(post);
  } catch (calErr) {
    log.error(`Calendar update failed for post ${post.id}: ${calErr instanceof Error ? calErr.message : String(calErr)}`);
  }
}

export async function createContentCalendarEvent(
  post: ContentQueue
): Promise<string | null> {
  try {
    const { createEvent } = await import("./google-calendar");
    const accounts = await listGmailAccounts();
    if (accounts.length === 0) return null;

    const accountId = accounts[0].id;
    const { hasCalendarAccess } = await import("./google-calendar");
    const hasAccess = await hasCalendarAccess(accountId);
    if (!hasAccess) return null;

    const truncatedContent = post.content.length > 50 ? post.content.slice(0, 50) + "…" : post.content;
    const scheduledAt = post.scheduledAt ? new Date(post.scheduledAt) : new Date();
    const endAt = new Date(scheduledAt.getTime() + 15 * 60 * 1000);

    const event = await createEvent(accountId, "primary", {
      summary: `Post: ${truncatedContent}`,
      description: `${post.content}\n\nStatus: ${post.status}\nPlatform: ${post.platform}`,
      start: { dateTime: scheduledAt.toISOString(), timeZone: "America/Chicago" },
      end: { dateTime: endAt.toISOString(), timeZone: "America/Chicago" },
    });

    return event.id;
  } catch (err) {
    log.error(`Calendar event creation failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function updateContentCalendarEvent(
  post: ContentQueue
): Promise<void> {
  if (!post.calendarEventId) return;

  try {
    const { updateEvent } = await import("./google-calendar");
    const accounts = await listGmailAccounts();
    if (accounts.length === 0) return;

    const accountId = accounts[0].id;
    const truncatedContent = post.content.length > 50 ? post.content.slice(0, 50) + "…" : post.content;

    await updateEvent(accountId, "primary", post.calendarEventId, {
      summary: `Published: ${truncatedContent}`,
      description: `${post.content}\n\nStatus: published\nPlatform: ${post.platform}${post.platformUrl ? `\nURL: ${post.platformUrl}` : ""}`,
    });
  } catch (err) {
    log.error(`Calendar event update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function deleteContentCalendarEvent(
  post: ContentQueue
): Promise<void> {
  if (!post.calendarEventId) return;

  try {
    const { deleteEvent } = await import("./google-calendar");
    const accounts = await listGmailAccounts();
    if (accounts.length === 0) return;

    const accountId = accounts[0].id;
    await deleteEvent(accountId, "primary", post.calendarEventId);
  } catch (err) {
    log.error(`Calendar event deletion failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function suggestPostingTimes(
  count: number,
  startDate: string,
  endDate: string,
  existingScheduled: Date[] = []
): string[] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const times: Date[] = [];

  const dayPriority: Record<number, number> = {
    1: 3, // Monday
    2: 2, // Tuesday
    3: 1, // Wednesday (highest)
    4: 2, // Thursday
    5: 3, // Friday
  };

  interface Slot {
    date: Date;
    priority: number;
    isPrimary: boolean;
  }

  const slots: Slot[] = [];
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);

  while (current <= end) {
    const dayOfWeek = current.getDay();
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      const priority = dayPriority[dayOfWeek] || 5;

      const morning = new Date(current);
      morning.setHours(14, 0, 0, 0); // 9 AM CT = 14:00 UTC (CDT)
      if (morning >= start && morning <= end) {
        slots.push({ date: morning, priority, isPrimary: true });
      }

      const afternoon = new Date(current);
      afternoon.setHours(20, 0, 0, 0); // 3 PM CT = 20:00 UTC (CDT)
      if (afternoon >= start && afternoon <= end) {
        slots.push({ date: afternoon, priority: priority + 5, isPrimary: false });
      }
    }
    current.setDate(current.getDate() + 1);
  }

  slots.sort((a, b) => a.priority - b.priority);

  const MIN_GAP_MS = 4 * 60 * 60 * 1000;
  const allScheduled = [...existingScheduled];

  for (const slot of slots) {
    if (times.length >= count) break;

    const tooClose = allScheduled.some(
      (existing) => Math.abs(slot.date.getTime() - existing.getTime()) < MIN_GAP_MS
    );

    if (!tooClose) {
      times.push(slot.date);
      allScheduled.push(slot.date);
    }
  }

  if (times.length < count) {
    for (const slot of slots) {
      if (times.length >= count) break;
      if (!times.some((t) => t.getTime() === slot.date.getTime())) {
        times.push(slot.date);
      }
    }
  }

  times.sort((a, b) => a.getTime() - b.getTime());
  return times.map((t) => t.toISOString());
}
