import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, X, Bookmark, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface SignalItem {
  id: string;
  sourceType: string;
  title: string;
  url: string;
  snippet: string;
  relevanceScore: number;
  relevanceTags: string[];
  matchingSkills: string[];
  matchingTheses: string[];
  status: string;
  publishedAt: string | null;
  createdAt: string;
}


export function cleanSignalText(text?: string | null): string {
  if (!text) return "";
  let cleaned = text;
  for (let i = 0; i < 3; i += 1) {
    const decoded = cleaned
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
    if (decoded === cleaned) break;
    cleaned = decoded;
  }
  return cleaned
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const SOURCE_LABELS: Record<string, string> = {
  web: "Web",
  x: "X",
  x_account: "X Account",
  reddit: "Reddit",
  rss: "RSS",
};

export function formatTimeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RelevanceBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = score >= 0.6 ? "bg-success" : score >= 0.3 ? "bg-warning" : "bg-neutral";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
    </div>
  );
}

interface SignalCardProps {
  signal: SignalItem;
  onDismiss?: (id: string) => void;
  onSave?: (id: string) => void;
}

export function SignalCard({ signal, onDismiss, onSave }: SignalCardProps) {
  const cleanTitle = cleanSignalText(signal.title);
  const cleanSnippet = cleanSignalText(signal.snippet);
  return (
    <Card className="group transition-colors">
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <Badge variant="outline" className="text-xs px-1 py-0 shrink-0">
                {SOURCE_LABELS[signal.sourceType] || signal.sourceType}
              </Badge>
              <RelevanceBar score={signal.relevanceScore} />
              <span className="text-xs text-muted-foreground">
                {formatTimeAgo(signal.publishedAt || signal.createdAt)}
              </span>
            </div>
            <a
              href={signal.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium hover:underline line-clamp-1 flex items-center gap-1"
            >
              {cleanTitle}
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            </a>
            {cleanSnippet && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{cleanSnippet}</p>
            )}
            {signal.relevanceTags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {signal.relevanceTags.slice(0, 5).map(tag => (
                  <span key={tag} className="text-xs px-1.5 py-0 rounded-full bg-muted text-muted-foreground">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {signal.status !== "saved" && onSave && (
                  <DropdownMenuItem onClick={() => onSave(signal.id)}>
                    <Bookmark className="h-3.5 w-3.5 mr-2" />
                    Save
                  </DropdownMenuItem>
                )}
                {signal.status !== "dismissed" && onDismiss && (
                  <DropdownMenuItem onClick={() => onDismiss(signal.id)}>
                    <X className="h-3.5 w-3.5 mr-2" />
                    Dismiss
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
