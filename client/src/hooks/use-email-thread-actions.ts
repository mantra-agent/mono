import { useMutation, type QueryKey } from "@tanstack/react-query";
import type { EmailMessage } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface EmailThreadMeta {
  providerThreadId?: string;
  accountId?: string;
  tier?: string;
  sender?: string;
  subject?: string;
}

export function useEmailMarkDone() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async ({ ids, isDone, threadMeta }: { ids: number[]; isDone: boolean; threadMeta?: EmailThreadMeta }) => {
      const results = await Promise.all(
        ids.map(async (id) => {
          const res = await apiRequest("PATCH", `/api/email/messages/${id}/done`, { isDone });
          return res.json() as Promise<EmailMessage & { gmailArchived?: boolean | null }>;
        })
      );
      if (isDone && threadMeta) {
        try {
          await apiRequest("POST", "/api/email/history/record", {
            messageId: ids[0],
            providerThreadId: threadMeta.providerThreadId || null,
            accountId: threadMeta.accountId || null,
            tier: threadMeta.tier || null,
            sender: threadMeta.sender || null,
            subject: threadMeta.subject || null,
            reason: "Manually marked done",
            dismissedBy: "manual",
          });
        } catch {}
      }
      return results;
    },
    onMutate: async ({ ids, isDone }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/email/messages"] });
      const queryCache = queryClient.getQueryCache();
      const matchingQueries = queryCache.findAll({ queryKey: ["/api/email/messages"] });
      const idSet = new Set(ids);
      const snapshots: Array<{ queryKey: QueryKey; data: unknown }> = [];
      for (const query of matchingQueries) {
        snapshots.push({ queryKey: query.queryKey, data: query.state.data });
        queryClient.setQueryData<{ messages: EmailMessage[]; total: number }>(query.queryKey, (old) => {
          if (!old) return old;
          const updated = old.messages.map((m) => idSet.has(m.id) ? { ...m, isDone } : m);
          return { ...old, messages: updated };
        });
      }

      const affectedMessages: EmailMessage[] = [];
      for (const snapshot of snapshots) {
        const data = snapshot.data as { messages: EmailMessage[]; total: number } | undefined;
        if (data?.messages) {
          for (const m of data.messages) {
            if (idSet.has(m.id) && !m.isDone) affectedMessages.push(m);
          }
        }
      }
      const seen = new Set<number>();
      let untriagedCount = 0;
      for (const m of affectedMessages) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (m.triageStatus === "untriaged") untriagedCount++;
      }

      await queryClient.cancelQueries({ queryKey: ["/api/email/messages", "review-count"] });
      await queryClient.cancelQueries({ queryKey: ["/api/email/messages", "inbox-count"] });
      await queryClient.cancelQueries({ queryKey: ["/api/email/messages", "triage-count"] });
      const prevReviewCount = queryClient.getQueryData<{ messages: EmailMessage[]; total: number }>(["/api/email/messages", "review-count"]);
      const prevInboxCount = queryClient.getQueryData<{ messages: EmailMessage[]; total: number }>(["/api/email/messages", "inbox-count"]);
      const prevTriageCount = queryClient.getQueryData<{ messages: EmailMessage[]; total: number }>(["/api/email/messages", "triage-count"]);
      if (isDone && prevInboxCount && untriagedCount > 0) {
        queryClient.setQueryData(["/api/email/messages", "inbox-count"], {
          ...prevInboxCount,
          total: Math.max(0, prevInboxCount.total - untriagedCount),
        });
      }
      return { snapshots, prevReviewCount, prevInboxCount, prevTriageCount };
    },
    onSuccess: (results, { isDone }, context) => {
      if (!isDone) return;
      const failedResults = results.filter((r) => r.gmailArchived !== null && r.gmailArchived === false);
      if (failedResults.length === 0) return;
      const failedIds = new Set(failedResults.map((r) => r.id));
      const matchingQueries = queryClient.getQueryCache().findAll({ queryKey: ["/api/email/messages"] });
      for (const query of matchingQueries) {
        if (query.queryKey.includes("review-count") || query.queryKey.includes("inbox-count") || query.queryKey.includes("triage-count")) continue;
        queryClient.setQueryData<{ messages: EmailMessage[]; total: number }>(query.queryKey, (old) => {
          if (!old) return old;
          return { ...old, messages: old.messages.map((m) => failedIds.has(m.id) ? { ...m, isDone: false } : m) };
        });
      }
      if (context?.prevReviewCount) queryClient.setQueryData(["/api/email/messages", "review-count"], context.prevReviewCount);
      if (context?.prevInboxCount) queryClient.setQueryData(["/api/email/messages", "inbox-count"], context.prevInboxCount);
      if (context?.prevTriageCount) queryClient.setQueryData(["/api/email/messages", "triage-count"], context.prevTriageCount);
      toast({
        title: "Email hidden locally",
        description: "Couldn't archive in Gmail — you may need to reconnect your account.",
        variant: "destructive",
      });
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshots) {
        for (const { queryKey, data } of context.snapshots) queryClient.setQueryData(queryKey, data);
      }
      if (context?.prevReviewCount) queryClient.setQueryData(["/api/email/messages", "review-count"], context.prevReviewCount);
      if (context?.prevInboxCount) queryClient.setQueryData(["/api/email/messages", "inbox-count"], context.prevInboxCount);
      if (context?.prevTriageCount) queryClient.setQueryData(["/api/email/messages", "triage-count"], context.prevTriageCount);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email/messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
    },
  });
}

export function useEmailSnooze() {
  return useMutation({
    mutationFn: async ({ ids, snoozedUntil }: { ids: number[]; snoozedUntil: string | null }) => {
      return Promise.all(
        ids.map(async (id) => {
          const res = await apiRequest("PATCH", `/api/email/messages/${id}/snooze`, { snoozedUntil });
          return res.json() as Promise<EmailMessage>;
        })
      );
    },
    onMutate: async ({ ids }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/email/messages"] });
      const matchingQueries = queryClient.getQueryCache().findAll({ queryKey: ["/api/email/messages"] });
      const idSet = new Set(ids);
      const snapshots: Array<{ queryKey: QueryKey; data: unknown }> = [];
      for (const query of matchingQueries) {
        snapshots.push({ queryKey: query.queryKey, data: query.state.data });
        queryClient.setQueryData<{ messages: EmailMessage[]; total: number }>(query.queryKey, (old) => {
          if (!old) return old;
          return {
            ...old,
            messages: old.messages.filter((m) => !idSet.has(m.id)),
            total: Math.max(0, old.total - ids.length),
          };
        });
      }
      return { snapshots };
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshots) {
        for (const { queryKey, data } of context.snapshots) queryClient.setQueryData(queryKey, data);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email/messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
    },
  });
}
