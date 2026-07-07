import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { X, Wifi, AlertTriangle, Loader2 } from "lucide-react";
import { getInstanceName } from "@/lib/instance-config";

interface PinnedTopic {
  id: string;
  sourceType: string;
  value: string;
  enabled: boolean;
  lastScanAt: string | null;
  signalCount: number;
  createdAt: string;
}

interface InterestTopic {
  tag: string;
  weight: number;
  source: "pinned" | "skill" | "goal" | "thesis" | "session";
  sourceRef: string;
}

interface InterestGraphData {
  topics: InterestTopic[];
  searchQueries: string[];
}

interface ScanRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  sourcesScanned: number;
  itemsFound: number;
  itemsSurfaced: number;
  itemsDeduped: number;
  error: string | null;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function LandscapeTopics({ embedded }: { embedded?: boolean }) {
  const [newTopic, setNewTopic] = useState("");

  // Pinned topics
  const { data: pinnedTopics, isLoading: topicsLoading } = useQuery<PinnedTopic[]>({
    queryKey: ["/api/landscape/topics"],
    queryFn: async () => {
      const res = await fetch("/api/landscape/topics");
      if (!res.ok) throw new Error("Failed to load topics");
      return res.json();
    },
  });

  // Interest graph (auto-derived)
  const { data: graphData } = useQuery<InterestGraphData>({
    queryKey: ["/api/landscape/interest-graph"],
    queryFn: async () => {
      const res = await fetch("/api/landscape/interest-graph");
      if (!res.ok) throw new Error("Failed to load interest graph");
      return res.json();
    },
  });

  // Last scan
  const { data: scanRuns } = useQuery<ScanRun[]>({
    queryKey: ["/api/landscape/scan-runs"],
    queryFn: async () => {
      const res = await fetch("/api/landscape/scan-runs?limit=1");
      if (!res.ok) throw new Error("Failed to load scan runs");
      return res.json();
    },
  });

  const addTopicMutation = useMutation({
    mutationFn: async (value: string) => {
      await apiRequest("POST", "/api/landscape/topics", { value });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/landscape/topics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/landscape/interest-graph"] });
      setNewTopic("");
    },
  });

  const removeTopicMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/landscape/topics/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/landscape/topics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/landscape/interest-graph"] });
    },
  });

  const cancelScanMutation = useMutation({
    mutationFn: async (runId: string) => {
      await apiRequest("POST", `/api/landscape/scan-runs/${runId}/cancel`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/landscape/scan-runs"] });
    },
  });

  const queries = graphData?.searchQueries || [];
  const lastScan = scanRuns?.[0];
  const isStuck = lastScan && !lastScan.completedAt &&
    (Date.now() - new Date(lastScan.startedAt).getTime()) > 5 * 60 * 1000;

  return (
    <div className={`flex flex-col gap-4 ${embedded ? "p-4" : "p-6"} overflow-y-auto`}>
      {/* Your Topics — chip input */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Your Topics</CardTitle>
          <p className="text-xs text-muted-foreground">
            These topics generate search queries for enabled channels.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {topicsLoading ? (
              <>
                <Skeleton className="h-7 w-24 rounded-full" />
                <Skeleton className="h-7 w-32 rounded-full" />
              </>
            ) : (pinnedTopics || []).length === 0 ? null : (
              (pinnedTopics || []).map(topic => (
                <Badge
                  key={topic.id}
                  variant="secondary"
                  className="text-xs pl-2.5 pr-1 py-1 gap-1 cursor-default"
                >
                  {topic.value}
                  <button
                    onClick={() => removeTopicMutation.mutate(topic.id)}
                    className="ml-0.5 hover:bg-muted rounded-full p-0.5 transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))
            )}
          </div>
          <Input
            value={newTopic}
            onChange={e => setNewTopic(e.target.value)}
            placeholder="Add a topic..."
            className="h-8 text-xs"
            onKeyDown={e => {
              if (e.key === "Enter" && newTopic.trim()) {
                addTopicMutation.mutate(newTopic.trim());
              }
            }}
          />
          {(pinnedTopics || []).length === 0 && !topicsLoading && (
            <p className="text-xs text-muted-foreground mt-2">
              Type a topic and press Enter. {getInstanceName()} also auto-derives interests from skills, theses, and goals.
            </p>
          )}
        </CardContent>
      </Card>


      {/* Generated queries */}
      {queries.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Generated Search Queries</CardTitle>
            <p className="text-xs text-muted-foreground">
              These queries are sent to enabled channels during scans.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {queries.map((q, i) => (
                <Badge key={i} variant="outline" className="text-xs">
                  {q}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Scan status */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isStuck ? (
                <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
              ) : (
                <Wifi className={`h-3.5 w-3.5 ${lastScan?.completedAt ? "text-success" : lastScan ? "text-warning animate-pulse" : "text-muted-foreground"}`} />
              )}
              <span className="text-xs font-medium">
                {isStuck
                  ? "Scan stuck — blocking new scans"
                  : lastScan?.completedAt
                    ? `Last scan ${formatDate(lastScan.completedAt)}`
                    : lastScan
                      ? "Scan in progress"
                      : "No scans yet"}
              </span>
              {lastScan?.completedAt && (
                <span className="text-xs text-muted-foreground">
                  {lastScan.itemsSurfaced} signals
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {isStuck && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={cancelScanMutation.isPending}
                  onClick={() => cancelScanMutation.mutate(lastScan.id)}
                >
                  {cancelScanMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Clear"}
                </Button>
              )}
              <Badge variant="outline" className="text-xs px-2 py-0.5">
                Scans run automatically
              </Badge>
            </div>
          </div>
          {lastScan?.error && (
            <p className="text-xs text-destructive mt-1">{lastScan.error}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
