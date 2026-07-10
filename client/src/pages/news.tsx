import { useCallback, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { createReferenceRef } from "@shared/references";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { usePageHeader } from "@/hooks/use-page-header";
import { useFocusSession } from "@/hooks/use-focus-session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { cleanSignalText, formatTimeAgo, type SignalItem } from "@/components/signal-card";
import { Bookmark, ChevronDown, ChevronRight, Globe, MessageCircle, MessageSquare, MoreHorizontal, Newspaper, Pin, Plug, Radio, Rss, Sparkles, Trash2, UserCircle, X } from "lucide-react";

interface NewsSignal extends SignalItem {
  curatedTitle?: string | null;
  curatedReason?: string | null;
  curationStatus?: string | null;
  curationScore?: number | null;
  matchedTopics?: string[];
  agentSummary?: string | null;
}

interface TopicRow {
  id: string;
  sourceType: string;
  value: string;
  enabled: boolean;
  lastScanAt: string | null;
  signalCount: number;
  createdAt: string;
  topicSource?: "pinned" | "session";
  alsoRecent?: boolean;
  mentions?: number;
  lastSeenAt?: string | null;
}

interface ChannelSource { id: string; sourceType: string; value: string; enabled: boolean; lastScanAt: string | null; signalCount: number; createdAt: string; }
type NewsSectionKey = "surface" | "feed" | "topics" | "channels" | "saved" | "dismissed";

const SECTION_META: Record<NewsSectionKey, { label: string }> = {
  surface: { label: "Surface" }, feed: { label: "Feed" }, topics: { label: "Topics" }, channels: { label: "Channels" }, saved: { label: "Saved" }, dismissed: { label: "Dismissed" },
};
const CHANNEL_META: Record<string, { label: string; icon: typeof Globe }> = {
  channel_web: { label: "Web Search", icon: Globe }, channel_x: { label: "X Search", icon: Radio }, subreddit: { label: "Subreddit", icon: MessageSquare }, rss_feed: { label: "RSS Feed", icon: Rss }, x_account: { label: "X Account", icon: UserCircle },
};
const SIGNAL_REF_TYPE: Record<string, string> = { web: "web_article", x: "x_item", x_account: "x_item", reddit: "reddit_post", rss: "rss_item" };

function formatSourceValue(source: ChannelSource): string { if (source.sourceType === "subreddit") return `r/${source.value}`; if (source.sourceType === "x_account") return `@${source.value}`; return CHANNEL_META[source.sourceType]?.label || source.value; }
function signalReference(signal: NewsSignal, label?: string) { return createReferenceRef({ type: SIGNAL_REF_TYPE[signal.sourceType] || "news", id: signal.url, metadata: { label: label || signal.curatedTitle || signal.title, href: signal.url, sourceType: signal.sourceType } }); }
function topicBadge(topic: TopicRow) { if (topic.topicSource === "session") return `Session${topic.mentions ? ` · ${topic.mentions}` : ""}`; if (topic.alsoRecent) return "Pinned · Recent"; return "Pinned"; }

function SignalRow({ signal, onDismiss, onSave, onConverse }: { signal: NewsSignal; onDismiss: (id: string) => void; onSave: (id: string) => void; onConverse: (signal: NewsSignal) => void; }) {
  const [expanded, setExpanded] = useState(false);
  const displayTitle = cleanSignalText(signal.curatedTitle || signal.title);
  const cleanReason = cleanSignalText(signal.curatedReason);
  const cleanSummary = cleanSignalText(signal.agentSummary);
  const cleanOriginalTitle = cleanSignalText(signal.title);
  const hasExpansion = Boolean(cleanSummary || cleanReason || cleanOriginalTitle);
  return (
    <div className="space-y-0.5">
      <div className="flex">
        <div className={cn("group relative flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/50", signal.status === "dismissed" ? "text-muted-foreground hover:text-foreground" : "text-foreground")} title={displayTitle}>
          <div className="min-w-0 flex-1">
            <ReferenceRenderer refValue={signalReference(signal, displayTitle)} surface="simple-row" className="mx-0 max-w-full text-sm font-medium" />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{formatTimeAgo(signal.publishedAt || signal.createdAt)}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {hasExpansion && <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setExpanded(v => !v)} aria-label={expanded ? "Collapse" : "Expand"}><ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")} /></Button>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onConverse(signal)}>
                  <MessageCircle className="h-3.5 w-3.5 mr-2" />
                  Converse
                </DropdownMenuItem>
                {signal.status !== "saved" && (
                  <DropdownMenuItem onClick={() => onSave(signal.id)}>
                    <Bookmark className="h-3.5 w-3.5 mr-2" />
                    Save
                  </DropdownMenuItem>
                )}
                {signal.status !== "dismissed" && (
                  <DropdownMenuItem onClick={() => onDismiss(signal.id)}>
                    <X className="h-3.5 w-3.5 mr-2" />
                    Dismiss
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="rounded-md border border-border/40 bg-card/40 p-3 text-sm">
          {cleanSummary && <p className="text-foreground">{cleanSummary}</p>}
          {cleanReason && <p className={cn("text-muted-foreground", cleanSummary && "mt-2")}>{cleanReason}</p>}
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            <div className="font-medium text-foreground/80">{cleanOriginalTitle}</div>
            {signal.matchedTopics?.length ? <div>Topics: {signal.matchedTopics.join(", ")}</div> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function TreeRow({ depth, icon: Icon, title, children, onClick, selected, muted }: { depth: number; icon: ComponentType<{ className?: string }>; title: string; children?: ReactNode; onClick?: () => void; selected?: boolean; muted?: boolean; }) {
  const content = <><Icon className="h-3.5 w-3.5 shrink-0" />{children || <span className="truncate">{title}</span>}</>;
  const className = cn("group relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors", selected ? "bg-accent text-foreground" : muted ? "text-muted-foreground hover:bg-accent/50 hover:text-foreground" : "text-foreground hover:bg-accent/50", onClick && "cursor-pointer");
  return <div className="flex" style={{ paddingLeft: Math.min(depth * 16, 96) }}>{depth > 0 && <div className="relative mr-1 w-5 self-stretch" aria-hidden="true"><div className="absolute bottom-1/2 left-1/2 top-0 border-l border-border/50" /><div className="absolute left-1/2 right-0 top-1/2 border-t border-border/50" /></div>}{onClick ? <button type="button" className={className} onClick={onClick} title={title}>{content}</button> : <div className={className} title={title}>{content}</div>}</div>;
}

function SectionHeader({ section, count, open, onToggle }: { section: NewsSectionKey; count?: number; open: boolean; onToggle: () => void; }) {
  const meta = SECTION_META[section];
  return <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}<span>{meta.label}</span>{typeof count === "number" && <span className="ml-auto tabular-nums">{count}</span>}</button>;
}

function buildSignalMessage(signal: NewsSignal): string {
  const title = signal.curatedTitle || signal.title;
  const parts = [`Let's discuss this: **${title}**`, `URL: ${signal.url}`];
  if (signal.agentSummary) parts.push(`\nSummary: ${signal.agentSummary}`);
  if (signal.curatedReason) parts.push(`\nAnalysis: ${signal.curatedReason}`);
  if (signal.matchedTopics?.length) parts.push(`\nTopics: ${signal.matchedTopics.join(", ")}`);
  return parts.join("\n");
}

export default function NewsPage() {
  usePageHeader({ title: "News" });
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const [openSections, setOpenSections] = useState<Set<NewsSectionKey>>(() => new Set(["surface"]));
  const [newTopic, setNewTopic] = useState(""); const [newSource, setNewSource] = useState("");

  const handleConverse = useCallback(async (signal: NewsSignal) => {
    try {
      const title = signal.curatedTitle || signal.title;
      const res = await apiRequest("POST", "/api/sessions", { title });
      const session: { id: string } = await res.json();
      const message = buildSignalMessage(signal);
      await fetch(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      setSessionForRoute(route, session.id);
      setWidgetOpen(true);
    } catch (err) {
      console.error("Failed to start conversation:", err);
    }
  }, [route, setSessionForRoute, setWidgetOpen]);
  const { data: surfacedData, isLoading: surfacedLoading } = useQuery<{ items: NewsSignal[]; total: number }>({ queryKey: ["/api/landscape/signals", "surfaced"], queryFn: async () => { const res = await fetch("/api/landscape/signals?status=surfaced&limit=20"); if (!res.ok) throw new Error("Failed to load surfaced signals"); return res.json(); } });
  const { data: feedData, isLoading: feedLoading } = useQuery<{ items: NewsSignal[]; total: number }>({ queryKey: ["/api/landscape/signals", "news-feed"], queryFn: async () => { const res = await fetch("/api/landscape/signals?status=new&limit=30"); if (!res.ok) throw new Error("Failed to load feed signals"); return res.json(); } });
  const { data: savedData, isLoading: savedLoading } = useQuery<{ items: NewsSignal[]; total: number }>({ queryKey: ["/api/landscape/signals", "saved"], queryFn: async () => { const res = await fetch("/api/landscape/signals?status=saved&limit=100"); if (!res.ok) throw new Error("Failed to load saved signals"); return res.json(); } });
  const { data: dismissedData, isLoading: dismissedLoading } = useQuery<{ items: NewsSignal[]; total: number }>({ queryKey: ["/api/landscape/signals", "dismissed"], queryFn: async () => { const res = await fetch("/api/landscape/signals?status=dismissed&limit=100"); if (!res.ok) throw new Error("Failed to load dismissed signals"); return res.json(); } });
  const { data: topics, isLoading: topicsLoading } = useQuery<TopicRow[]>({ queryKey: ["/api/landscape/topics"], queryFn: async () => { const res = await fetch("/api/landscape/topics"); if (!res.ok) throw new Error("Failed to load topics"); return res.json(); } });
  const { data: channels, isLoading: channelsLoading } = useQuery<ChannelSource[]>({ queryKey: ["/api/landscape/channels"], queryFn: async () => { const res = await fetch("/api/landscape/channels"); if (!res.ok) throw new Error("Failed to load channels"); return res.json(); } });
  const statusMutation = useMutation({ mutationFn: async ({ id, status }: { id: string; status: string }) => apiRequest("PATCH", `/api/landscape/signals/${id}/status`, { status }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/landscape/signals"] }) });
  const addTopicMutation = useMutation({ mutationFn: async (value: string) => apiRequest("POST", "/api/landscape/topics", { value }), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/landscape/topics"] }); setNewTopic(""); } });
  const removeTopicMutation = useMutation({ mutationFn: async (id: string) => apiRequest("DELETE", `/api/landscape/topics/${id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/landscape/topics"] }) });
  const toggleChannelMutation = useMutation({ mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => apiRequest("PATCH", `/api/landscape/sources/${id}`, { enabled }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/landscape/channels"] }) });
  const addSourceMutation = useMutation({ mutationFn: async (value: string) => apiRequest("POST", "/api/landscape/sources", { sourceType: "rss_feed", value }), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/landscape/channels"] }); setNewSource(""); } });
  const deleteSourceMutation = useMutation({ mutationFn: async (id: string) => apiRequest("DELETE", `/api/landscape/sources/${id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/landscape/channels"] }) });
  const surfaced = surfacedData?.items || []; const feed = feedData?.items || []; const saved = savedData?.items || []; const dismissed = dismissedData?.items || []; const topicRows = topics || []; const channelRows = channels || [];
  const counts = useMemo(() => ({ surface: surfacedData?.total ?? surfaced.length, feed: feedData?.total ?? feed.length, topics: topicRows.length, channels: channelRows.length, saved: savedData?.total ?? saved.length, dismissed: dismissedData?.total ?? dismissed.length }), [surfacedData?.total, surfaced.length, feedData?.total, feed.length, topicRows.length, channelRows.length, savedData?.total, saved.length, dismissedData?.total, dismissed.length]);
  const toggleSection = (section: NewsSectionKey) => setOpenSections(prev => { const next = new Set(prev); if (next.has(section)) next.delete(section); else next.add(section); return next; });
  return <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background"><div className="flex-1 overflow-y-auto p-3 scrollbar-thin"><div className="space-y-1">
    <SectionHeader section="surface" count={counts.surface} open={openSections.has("surface")} onToggle={() => toggleSection("surface")} />{openSections.has("surface") && <div className="space-y-0.5">{surfacedLoading ? <Skeleton className="h-8 rounded-md" /> : surfaced.length === 0 ? <TreeRow depth={0} icon={Sparkles} title="Nothing surfaced yet" muted /> : surfaced.map(signal => <SignalRow key={signal.id} signal={signal} onDismiss={id => statusMutation.mutate({ id, status: "dismissed" })} onSave={id => statusMutation.mutate({ id, status: "saved" })} onConverse={handleConverse} />)}</div>}
    <SectionHeader section="feed" count={counts.feed} open={openSections.has("feed")} onToggle={() => toggleSection("feed")} />{openSections.has("feed") && <div className="space-y-0.5">{feedLoading ? <Skeleton className="h-8 rounded-md" /> : feed.length === 0 ? <TreeRow depth={0} icon={Radio} title="No new feed signals" muted /> : feed.map(signal => <SignalRow key={signal.id} signal={signal} onDismiss={id => statusMutation.mutate({ id, status: "dismissed" })} onSave={id => statusMutation.mutate({ id, status: "saved" })} onConverse={handleConverse} />)}</div>}
    <SectionHeader section="topics" count={counts.topics} open={openSections.has("topics")} onToggle={() => toggleSection("topics")} />{openSections.has("topics") && <div className="space-y-0.5">{topicsLoading ? <Skeleton className="h-8 rounded-md" /> : topicRows.length === 0 ? <TreeRow depth={0} icon={Newspaper} title="No topics" muted /> : topicRows.map(topic => <TreeRow key={topic.id} depth={0} icon={topic.topicSource === "session" ? Radio : Newspaper} title={topic.value} muted={!topic.enabled}><span className="truncate">{topic.value}</span><Badge variant="outline" className="ml-auto px-1.5 py-0 text-xs">{topicBadge(topic)}</Badge>{topic.signalCount > 0 && <Badge variant="outline" className="px-1.5 py-0 text-xs">{topic.signalCount}</Badge>}{topic.topicSource === "session" ? <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 transition-opacity group-hover:opacity-100" onClick={event => { event.stopPropagation(); addTopicMutation.mutate(topic.value); }}><Pin className="h-3.5 w-3.5" /></Button> : <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 transition-opacity group-hover:opacity-100" onClick={event => { event.stopPropagation(); removeTopicMutation.mutate(topic.id); }}><X className="h-3.5 w-3.5" /></Button>}</TreeRow>)}<div className="flex px-2 pt-1"><Input value={newTopic} onChange={event => setNewTopic(event.target.value)} placeholder="Add topic..." className="h-7 text-xs" onKeyDown={event => { if (event.key === "Enter" && newTopic.trim()) addTopicMutation.mutate(newTopic.trim()); }} /></div></div>}
    <SectionHeader section="channels" count={counts.channels} open={openSections.has("channels")} onToggle={() => toggleSection("channels")} />{openSections.has("channels") && <div className="space-y-0.5">{channelsLoading ? <Skeleton className="h-8 rounded-md" /> : channelRows.length === 0 ? <TreeRow depth={0} icon={Plug} title="No channels configured" muted /> : channelRows.map(source => { const meta = CHANNEL_META[source.sourceType] || { label: source.sourceType, icon: Plug }; return <TreeRow key={source.id} depth={0} icon={meta.icon} title={formatSourceValue(source)} muted={!source.enabled}><span className="truncate">{formatSourceValue(source)}</span><span className="ml-auto shrink-0 text-xs text-muted-foreground">{meta.label}</span>{source.signalCount > 0 && <Badge variant="outline" className="px-1.5 py-0 text-xs">{source.signalCount}</Badge>}<Switch checked={source.enabled} onCheckedChange={enabled => toggleChannelMutation.mutate({ id: source.id, enabled })} className="scale-75" />{!source.sourceType.startsWith("channel_") && <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 transition-opacity group-hover:opacity-100" onClick={event => { event.stopPropagation(); deleteSourceMutation.mutate(source.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>}</TreeRow>; })}<div className="flex px-2 pt-1"><Input value={newSource} onChange={event => setNewSource(event.target.value)} placeholder="Add RSS feed..." className="h-7 text-xs" onKeyDown={event => { if (event.key === "Enter" && newSource.trim()) addSourceMutation.mutate(newSource.trim()); }} /></div></div>}
    <SectionHeader section="saved" count={counts.saved} open={openSections.has("saved")} onToggle={() => toggleSection("saved")} />{openSections.has("saved") && <div className="space-y-0.5">{savedLoading ? <Skeleton className="h-8 rounded-md" /> : saved.length === 0 ? <TreeRow depth={0} icon={Bookmark} title="No saved news" muted /> : saved.map(signal => <SignalRow key={signal.id} signal={signal} onDismiss={id => statusMutation.mutate({ id, status: "dismissed" })} onSave={id => statusMutation.mutate({ id, status: "saved" })} onConverse={handleConverse} />)}</div>}
    <SectionHeader section="dismissed" count={counts.dismissed} open={openSections.has("dismissed")} onToggle={() => toggleSection("dismissed")} />{openSections.has("dismissed") && <div className="space-y-0.5">{dismissedLoading ? <Skeleton className="h-8 rounded-md" /> : dismissed.length === 0 ? <TreeRow depth={0} icon={X} title="No dismissed news" muted /> : dismissed.map(signal => <SignalRow key={signal.id} signal={signal} onDismiss={id => statusMutation.mutate({ id, status: "dismissed" })} onSave={id => statusMutation.mutate({ id, status: "saved" })} onConverse={handleConverse} />)}</div>}
  </div></div></div>;
}
