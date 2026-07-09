import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Trash2, Clock, Globe, Twitter, MessageSquare, Rss, UserCircle, Newspaper, Github, BarChart3, TrendingUp, Video } from "lucide-react";

interface ChannelSource {
  id: string;
  sourceType: string;
  value: string;
  enabled: boolean;
  lastScanAt: string | null;
  signalCount: number;
  createdAt: string;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const CHANNEL_META: Record<string, { label: string; icon: typeof Globe; description: string }> = {
  channel_web: { label: "Web Search", icon: Globe, description: "Sends topic-generated queries to Brave web search" },
  channel_x: { label: "X Search", icon: Twitter, description: "Sends topic-generated queries to X/Twitter search" },
};

const DIRECT_SECTIONS: Array<{
  type: string;
  label: string;
  icon: typeof MessageSquare;
  placeholder: string;
  normalize: (v: string) => string;
}> = [
  {
    type: "subreddit",
    label: "Subreddits",
    icon: MessageSquare,
    placeholder: "r/machinelearning",
    normalize: (v: string) => v.replace(/^r\//, "").trim(),
  },
  {
    type: "rss_feed",
    label: "RSS Feeds",
    icon: Rss,
    placeholder: "https://example.com/feed.xml",
    normalize: (v: string) => v.trim(),
  },
  {
    type: "x_account",
    label: "X Accounts",
    icon: UserCircle,
    placeholder: "@sama",
    normalize: (v: string) => v.replace(/^@/, "").trim(),
  },
  {
    type: "hackernews",
    label: "Hacker News",
    icon: Newspaper,
    placeholder: "AI agents (keyword) or * for top stories",
    normalize: (v: string) => v.trim(),
  },
  {
    type: "github_repo",
    label: "GitHub Repos",
    icon: Github,
    placeholder: "anthropics/claude-code",
    normalize: (v: string) => v.replace(/^https?:\/\/github\.com\//, "").trim(),
  },
  {
    type: "polymarket",
    label: "Polymarket",
    icon: BarChart3,
    placeholder: "ai (tag filter) or * for trending",
    normalize: (v: string) => v.trim(),
  },
  {
    type: "stocktwits",
    label: "StockTwits",
    icon: TrendingUp,
    placeholder: "NVDA (ticker) or TRENDING",
    normalize: (v: string) => v.trim().toUpperCase(),
  },
  {
    type: "arxiv",
    label: "arXiv",
    icon: Newspaper,
    placeholder: "cs.AI (category) or large language models (keyword)",
    normalize: (v: string) => v.trim(),
  },
  {
    type: "youtube_channel",
    label: "YouTube Channels",
    icon: Video,
    placeholder: "UCHnyfMqiRRG1u-2MsSQLbXA (channel ID)",
    normalize: (v: string) => v.trim(),
  },
];

export default function LandscapeSources({ embedded }: { embedded?: boolean }) {
  const { data: channels, isLoading } = useQuery<ChannelSource[]>({
    queryKey: ["/api/landscape/channels"],
    queryFn: async () => {
      const res = await fetch("/api/landscape/channels");
      if (!res.ok) throw new Error("Failed to load channels");
      return res.json();
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await apiRequest("PATCH", `/api/landscape/sources/${id}`, { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/landscape/channels"] });
    },
  });

  const addMutation = useMutation({
    mutationFn: async (data: { sourceType: string; value: string }) => {
      await apiRequest("POST", "/api/landscape/sources", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/landscape/channels"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/landscape/sources/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/landscape/channels"] });
    },
  });

  // Split channels from direct sources
  const queryChannels = (channels || []).filter(s => s.sourceType === "channel_x" || s.sourceType === "channel_web");
  const directSources = (channels || []).filter(s => !s.sourceType.startsWith("channel_"));

  return (
    <div className={`flex flex-col gap-4 ${embedded ? "p-4" : "p-6"} overflow-y-auto`}>
      {/* Query Channels */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Query Channels</CardTitle>
          <p className="text-xs text-muted-foreground">
            These receive search queries generated from your Topics.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-12 w-full rounded" />
              <Skeleton className="h-12 w-full rounded" />
            </div>
          ) : queryChannels.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              Channel toggles will appear after the first scan runs.
            </p>
          ) : (
            <div className="flex flex-col divide-y">
              {queryChannels.map(ch => {
                const meta = CHANNEL_META[ch.sourceType];
                const Icon = meta?.icon || Globe;
                return (
                  <div key={ch.id} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="text-sm font-medium">{meta?.label || ch.value}</div>
                        <div className="text-xs text-muted-foreground">{meta?.description}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {ch.lastScanAt && (
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" />
                          {formatDate(ch.lastScanAt)}
                        </span>
                      )}
                      {ch.signalCount > 0 && (
                        <Badge variant="secondary" className="text-xs font-mono px-1 py-0">
                          {ch.signalCount}
                        </Badge>
                      )}
                      <Switch
                        checked={ch.enabled}
                        onCheckedChange={enabled => toggleMutation.mutate({ id: ch.id, enabled })}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Direct Sources */}
      {DIRECT_SECTIONS.map(section => {
        const items = directSources.filter(s => s.sourceType === section.type);
        return (
          <DirectSourceSection
            key={section.type}
            section={section}
            items={items}
            isLoading={isLoading}
            onToggle={(id, enabled) => toggleMutation.mutate({ id, enabled })}
            onAdd={value => addMutation.mutate({ sourceType: section.type, value: section.normalize(value) })}
            onDelete={id => deleteMutation.mutate(id)}
          />
        );
      })}

    </div>
  );
}

function DirectSourceSection({
  section,
  items,
  isLoading,
  onToggle,
  onAdd,
  onDelete,
}: {
  section: typeof DIRECT_SECTIONS[number];
  items: ChannelSource[];
  isLoading: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onAdd: (value: string) => void;
  onDelete: (id: string) => void;
}) {
  const [newValue, setNewValue] = useState("");
  const Icon = section.icon;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          <CardTitle className="text-sm font-semibold">{section.label}</CardTitle>
          {items.length > 0 && (
            <Badge variant="outline" className="text-xs px-1.5 py-0">{items.length}</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-full rounded" />
        ) : (
          <>
            {items.length > 0 && (
              <div className="flex flex-col divide-y mb-3">
                {items.map(source => (
                  <div key={source.id} className="flex items-center justify-between py-2 group">
                    <div className="flex items-center gap-2 min-w-0">
                      <Switch
                        checked={source.enabled}
                        onCheckedChange={enabled => onToggle(source.id, enabled)}
                        className="scale-75"
                      />
                      <span className={`text-sm truncate ${!source.enabled ? "text-muted-foreground" : ""}`}>
                        {source.sourceType === "subreddit" ? `r/${source.value}` : source.sourceType === "x_account" ? `@${source.value}` : source.value}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {source.lastScanAt && (
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" />
                          {formatDate(source.lastScanAt)}
                        </span>
                      )}
                      {source.signalCount > 0 && (
                        <Badge variant="secondary" className="text-xs font-mono px-1 py-0">
                          {source.signalCount}
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
                        onClick={() => onDelete(source.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <Input
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              placeholder={section.placeholder}
              className="h-8 text-xs"
              onKeyDown={e => {
                if (e.key === "Enter" && newValue.trim()) {
                  onAdd(newValue.trim());
                  setNewValue("");
                }
              }}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
