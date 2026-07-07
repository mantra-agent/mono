import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ChatMessage } from "@/components/chat-shared";
import type { WorkflowWidgetRun } from "@/components/workflow-shared";
import { ACTIVE_WORKFLOW_STATUSES } from "@/components/workflow-shared";

const WORKFLOW_ID_RE = /(?:Workflow Run ID|Run ID):\s*(\S+)/i;

function extractLatestWorkflowId(messages: ChatMessage[]): string | null {
  let latest: string | null = null;
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (tc.toolName !== "workflows" || tc.status !== "done") continue;
      const output = typeof tc.result === "string" ? tc.result : typeof tc.output === "string" ? tc.output : tc.result != null ? JSON.stringify(tc.result) : "";
      const match = output.match(WORKFLOW_ID_RE);
      if (match) latest = match[1];
    }
  }
  return latest;
}

export function useWorkflowForSession(messages: ChatMessage[], serverWorkflowId?: string | null): { workflowId: string | null; workflow: WorkflowWidgetRun | null; isLoading: boolean } {
  const messageWorkflowId = useMemo(() => extractLatestWorkflowId(messages), [messages]);
  const workflowId = serverWorkflowId || messageWorkflowId;
  const { data: workflow, isLoading } = useQuery<WorkflowWidgetRun>({ queryKey: ["/api/workflows/runs", workflowId], queryFn: async () => { const res = await apiRequest("GET", `/api/workflows/runs/${workflowId}`); return res.json(); }, enabled: !!workflowId, refetchInterval: (query) => { const status = query.state.data?.run.status; return status && ACTIVE_WORKFLOW_STATUSES.has(status) ? 5000 : false; }, staleTime: 2000 });
  return { workflowId, workflow: workflow ?? null, isLoading: !!workflowId && isLoading };
}
