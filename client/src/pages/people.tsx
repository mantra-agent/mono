import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef, Fragment, type ReactNode } from "react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { ExpandableInteractionRow, type PersonInteraction } from "@/components/people/expandable-interaction-row";
import { InlineDatePicker } from "@/components/inline-date-picker";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation, Link } from "wouter";
import { getInstanceName } from "@/lib/instance-config";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageHeader } from "@/hooks/use-page-header";
import { useFocusContext } from "@/hooks/use-focus-context";
import { useToast } from "@/hooks/use-toast";
import { SurfacedPersonRow, surfacedDateLabel } from "@/components/people/surfaced-person-row";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { CompanyReferenceField } from "@/components/people/company-reference-field";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { formatRelativeDate } from "@/lib/local-date";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  Edit3,
  FileText,
  Heart,
  Loader2,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Phone,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Shield,
  ShieldOff,
  SlidersHorizontal,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Trash2,
  TrendingUp,
  User,
  Users,
  Video,
  ContactRound,
  Download,
  Smartphone,
  X,
  Brain,
  Link2,
  Unlink,
  Linkedin,
} from "lucide-react";
import { SiInstagram, SiX } from "react-icons/si";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SimpleFeed, SimpleFeedItem } from "@shared/models/simple";
import { fromCivilDate, parseDateString } from "@shared/civil-date";

type NativeWebViewWindow = Window & {
  ReactNativeWebView?: {
    postMessage?: (message: string) => void;
  };
};

function hasNativeWebViewBridge() {
  if (typeof window === "undefined") return false;
  const nativeWindow = window as NativeWebViewWindow;
  return typeof nativeWindow.ReactNativeWebView?.postMessage === "function";
}

function requestIosContactsImport() {
  if (!hasNativeWebViewBridge()) return false;
  const nativeWindow = window as NativeWebViewWindow;
  nativeWindow.ReactNativeWebView!.postMessage!(JSON.stringify({ type: "contacts.import.request" }));
  return true;
}

interface PersonIndex {
  id: string;
  name: string;
  nicknames: string[];
  cabinetLevel: string;
  tags: string[];
  lastInteractionDate?: string;
  createdAt?: string;
  updatedAt?: string;
  lastViewedAt?: string;
  private: boolean;
  company?: string;
  companyId?: string;
  role?: string;
}

interface ContactInfo {
  type: "email" | "phone" | "social" | "other";
  label: string;
  value: string;
}

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

type Interaction = PersonInteraction;

interface RelationshipState {
  temperature?: "hot" | "warm" | "cool" | "cold";
  momentum?: "rising" | "steady" | "falling";
  status?: "active" | "dormant" | "new" | "repairing";
}

interface RelationshipCadence {
  targetDays?: number;
  flexDays?: number;
  cadenceClass?: string;
}

interface RelationshipRollup {
  lastInteractionAt?: string;
  lastMeaningfulAt?: string;
  interactionCount30d?: number;
  interactionCount90d?: number;
  meaningfulCount90d?: number;
  avgMeaningfulness?: string;
  dominantChannel?: string;
  directionBalance?: string;
}

interface RelationshipOutreach {
  nextSuggestedAt?: string;
  reason?: string;
  recommendedChannel?: string;
  dueStatus?: string;
}

interface RelationshipProfile {
  state?: RelationshipState;
  cadence?: RelationshipCadence;
  rollup?: RelationshipRollup;
  outreach?: RelationshipOutreach;
}

interface Commitment {
  id: string;
  direction: "from_ray" | "to_ray";
  description: string;
  status: "open" | "fulfilled" | "expired";
  createdAt: string;
  resolvedAt?: string;
}

interface SocialCapital {
  balance: string;
  depositsFromRay: string[];
  depositsToRay: string[];
  lastDeposit?: string;
  lastWithdrawal?: string;
}

interface NetworkConnection {
  name: string;
  relationship: string;
  domain?: string;
}

interface Mobilization {
  ready: boolean;
  blockers: string[];
  warmingPath?: string;
  estimated: boolean;
}

interface NetworkProfile {
  expertise?: string[];
  domains?: string[];
  resources?: string[];
  canHelpWith?: string[];
  connections?: NetworkConnection[];
  capital?: SocialCapital;
  commitments?: Commitment[];
  mobilization?: Mobilization;
}

interface ImportantDate {
  id: string;
  label: string;
  date: string;
  recurrence: "annual" | "one-time";
}

interface SocialProfiles {
  instagram?: string;
  x?: string;
  linkedin?: string;
}

interface Person {
  id: string;
  name: string;
  nicknames: string[];
  cabinetLevel: string;
  photo?: string;
  birthday?: string;
  company?: string;
  companyId?: string;
  role?: string;
  professionalRelations?: string[];
  relation?: string;
  introducedBy?: string;
  familiarity?: "none" | "surface" | "deep";
  trust?: "ally" | "positive" | "none" | "negative" | "enemy";
  met?: string;
  socialProfiles: SocialProfiles;
  contactInfo: ContactInfo[];
  importantDates: ImportantDate[];
  notes: Note[];
  interactions: Interaction[];
  tags: string[];
  aiSummary?: string;
  quickSummary?: string;
  identityContent?: string;
  private: boolean;
  createdAt: string;
  updatedAt: string;
  relationshipProfile?: RelationshipProfile;
  networkProfile?: NetworkProfile;
}

interface CabinetLevel {
  id: string;
  name: string;
  color?: string;
  order: number;
}

interface CabinetConfig {
  levels: CabinetLevel[];
}

const INTERACTION_ICONS: Record<string, typeof MessageSquare> = {
  message: MessageSquare,
  call: Phone,
  meeting: Video,
  meetup: Users,
  email: Mail,
  note: Edit3,
  text: MessageSquare,
  in_person: Users,
  video: Video,
  social: Users,
  gift: Sparkles,
  introduction: Link2,
  favor: TrendingUp,
  support: Shield,
};

const RELATION_OPTIONS = [
  "Mother", "Father", "Biological Father", "Step Mother", "Step Father",
  "Brother", "Sister", "Half Brother", "Half Sister", "Step Brother", "Step Sister",
  "Grandmother", "Grandfather", "Step Grandmother", "Step Grandfather",
  "Aunt", "Uncle", "Cousin", "Step Cousin",
  "Son", "Daughter", "Step Son", "Step Daughter",
  "Nephew", "Niece", "Husband", "Wife", "Spouse", "Ex-Spouse", "In-Law", "Other",
];

const PROFESSIONAL_RELATION_OPTIONS = [
  "Partner", "Investor", "Advisor", "Colleague", "Employee", "Vendor", "Customer",
];

function daysAgo(dateStr?: string): string {
  if (!dateStr) return "Never";
  const d = parseDateString(dateStr);
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return `${diff}d`;
  if (diff < 30) return `${Math.floor(diff / 7)}w`;
  if (diff < 365) return `${Math.floor(diff / 30)}mo`;
  return `${Math.floor(diff / 365)}y`;
}

function formatShortDate(dateStr: string): string {
  const d = parseDateString(dateStr);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function tokenize(str: string): string[] {
  return str.toLowerCase().replace(/[,.'"\-_]/g, " ").split(/\s+/).filter(Boolean);
}

function editDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > 3) return Math.max(a.length, b.length);
  const dp: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    dp[i] = [i];
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = i === 0 ? j : 0;
    }
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function fuzzyTokenMatch(queryToken: string, targetToken: string): number {
  if (targetToken === queryToken) return 1;
  if (targetToken.startsWith(queryToken)) return 0.9;
  if (queryToken.length >= 3 && targetToken.includes(queryToken)) return 0.7;
  const dist = editDistance(queryToken, targetToken);
  const maxLen = Math.max(queryToken.length, targetToken.length);
  if (maxLen === 0) return 0;
  const similarity = 1 - dist / maxLen;
  if (dist > 1 && queryToken.length <= 4) return 0;
  return similarity >= 0.75 ? similarity * 0.8 : 0;
}

function fuzzyMatchPeople(query: string, people: PersonIndex[], limit: number): PersonIndex[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scored: { person: PersonIndex; score: number }[] = [];

  for (const person of people) {
    const nameTokens = tokenize(person.name);
    const nickTokens = (person.nicknames || []).flatMap(n => tokenize(n));
    const allTargetTokens = [...nameTokens, ...nickTokens];

    if (allTargetTokens.length === 0) continue;

    let totalScore = 0;
    let matchedQueryTokens = 0;

    for (const qt of queryTokens) {
      let bestMatch = 0;
      for (const tt of allTargetTokens) {
        const s = fuzzyTokenMatch(qt, tt);
        if (s > bestMatch) bestMatch = s;
      }
      totalScore += bestMatch;
      if (bestMatch > 0.3) matchedQueryTokens++;
    }

    if (matchedQueryTokens === 0) continue;

    const coverage = matchedQueryTokens / queryTokens.length;
    const avgScore = totalScore / queryTokens.length;
    const finalScore = avgScore * 0.6 + coverage * 0.4;

    if (finalScore > 0.4 && coverage >= 0.5) {
      scored.push({ person, score: finalScore });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.person);
}


type SortMode = "lastInteraction" | "name";

function PeopleListView({ selectedId, onSelect, searchOverride, showQuickAddOverride, onQuickAddClose, onRequestQuickAdd, sortMode, simpleFeed, selectedImportEmail, onSelectImportCandidate }: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  searchOverride?: string;
  showQuickAddOverride?: boolean;
  onQuickAddClose?: () => void;
  onRequestQuickAdd?: () => void;
  sortMode: SortMode;
  simpleFeed?: SimpleFeed;
  selectedImportEmail?: string | null;
  onSelectImportCandidate?: (email: string) => void;
}) {
  const { toast } = useToast();
  const { isAdmin } = useAuth();
  const searchQuery = searchOverride ?? "";
  const showQuickAdd = showQuickAddOverride ?? false;
  const [newName, setNewName] = useState("");
  const [newCabinet, setNewCabinet] = useState("");
  const quickAddRef = useRef<HTMLInputElement>(null);

  const { data: cabinetData } = useQuery<CabinetConfig>({
    queryKey: ["/api/people/cabinet-config"],
  });

  const { data: peopleData, isLoading } = useQuery<{ people: PersonIndex[] }>({
    queryKey: ["/api/people"],
    refetchInterval: 10000,
  });

  const { data: importStatus } = useQuery<{ pending: number }>({
    queryKey: ["/api/import-queue/status"],
    refetchInterval: 60_000,
    enabled: isAdmin,
  });

  const { data: importCandidatesData } = useQuery<{ candidates: ImportCandidate[] }>({
    queryKey: ["/api/import-queue/candidates"],
    refetchInterval: 60_000,
    enabled: isAdmin,
  });

  const searchResults = useQuery<{ people: PersonIndex[] }>({
    queryKey: ["/api/people/search", searchQuery],
    queryFn: async () => {
      const res = await fetch(`/api/people/search?q=${encodeURIComponent(searchQuery)}`);
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: searchQuery.length > 0,
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; cabinetLevel: string }) => {
      const res = await apiRequest("POST", "/api/people", data);
      return res.json();
    },
    onSuccess: (person: Person) => {
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      onQuickAddClose?.();
      setNewName("");
      setNewCabinet("");
      toast({ title: `Added ${person.name}` });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add person", description: err.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    if (showQuickAdd && quickAddRef.current) {
      quickAddRef.current.focus();
    }
  }, [showQuickAdd]);

  const levels = cabinetData?.levels || [];
  const people = searchQuery.length > 0 ? (searchResults.data?.people || []) : (peopleData?.people || []);

  const groupedPeople = useMemo(() => {
    const groups: Record<string, PersonIndex[]> = {};
    for (const person of people) {
      if (!groups[person.cabinetLevel]) groups[person.cabinetLevel] = [];
      groups[person.cabinetLevel].push(person);
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => {
        if (sortMode === "name") return a.name.localeCompare(b.name);
        const dateA = a.lastInteractionDate ? new Date(a.lastInteractionDate).getTime() : 0;
        const dateB = b.lastInteractionDate ? new Date(b.lastInteractionDate).getTime() : 0;
        return dateB - dateA;
      });
    }
    return groups;
  }, [people, sortMode]);

  const sortedLevels = useMemo(() => {
    return [...levels].sort((a, b) => a.order - b.order);
  }, [levels]);

  const surfacedItems = useMemo((): SimpleFeedItem[] => {
    const peopleById = new Set(people.map(p => p.id));
    const inbox = simpleFeed?.sections.find(section => section.section === "inbox")?.items ?? [];
    return inbox.filter(item => {
      if (item.widgetType !== "person") return false;
      const personId = item.sourceRefs.find(ref => ref.type === "person")?.id;
      return personId ? peopleById.has(personId) : false;
    });
  }, [people, simpleFeed]);

  const importCandidates = importCandidatesData?.candidates || [];
  const importPending = importStatus?.pending ?? importCandidates.length;
  const visibleImportCandidates = useMemo(() => {
    const source = searchQuery.length > 0
      ? importCandidates.filter(candidate =>
        (candidate.name || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
        candidate.email.toLowerCase().includes(searchQuery.toLowerCase())
      )
      : importCandidates;
    return source.slice(0, 25);
  }, [importCandidates, searchQuery]);

  const handleQuickAdd = useCallback(() => {
    if (!newName.trim()) return;
    const cabinet = newCabinet || sortedLevels[sortedLevels.length - 1]?.id || "network";
    createMutation.mutate({ name: newName.trim(), cabinetLevel: cabinet });
  }, [newName, newCabinet, sortedLevels, createMutation]);

  const renderPersonRow = useCallback((person: PersonIndex) => {
    const isSelected = selectedId === person.id;
    const isNew = person.createdAt && person.updatedAt &&
      Math.abs(new Date(person.createdAt).getTime() - new Date(person.updatedAt).getTime()) < 5000;
    const isUnread = !person.lastViewedAt || (person.updatedAt && new Date(person.updatedAt) > new Date(person.lastViewedAt));
    const titleClass = isUnread ? "text-foreground" : isNew ? "text-foreground" : isSelected ? "text-foreground" : "text-muted-foreground";
    return (
      <div
        key={person.id}
        className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left cursor-pointer select-none transition-colors overflow-hidden ${isSelected ? "bg-accent" : "hover:bg-accent/70"}`}
        onClick={() => onSelect(person.id)}
        data-testid={`person-row-${person.id}`}
      >
        <User className={`h-3.5 w-3.5 shrink-0 ${titleClass}`} />
        <span className={`truncate flex-1 min-w-0 pr-2 ${titleClass}`}>
          {person.name}
          {person.nicknames && person.nicknames.length > 0 && (
            <span className="text-xs text-muted-foreground ml-1">({person.nicknames[0]})</span>
          )}
        </span>
        {person.private && (
          <Shield className="h-3 w-3 text-muted-foreground/50 shrink-0" />
        )}
      </div>
    );
  }, [selectedId, onSelect]);

  return (
    <div className="space-y-1" data-testid="people-list-view">
      {showQuickAdd && (
        <div className="p-2 border-b mb-1">
          <div className="space-y-2">
            <Input
              ref={quickAddRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name"
              className="h-8 text-sm"
              onKeyDown={(e) => { if (e.key === "Enter") handleQuickAdd(); if (e.key === "Escape") onQuickAddClose?.(); }}
              data-testid="input-new-person-name"
            />
            <div className="flex gap-2">
              <Select value={newCabinet} onValueChange={setNewCabinet}>
                <SelectTrigger className="h-8 text-xs flex-1" data-testid="select-new-person-cabinet">
                  <SelectValue placeholder="Level" />
                </SelectTrigger>
                <SelectContent>
                  {sortedLevels.map((level) => (
                    <SelectItem key={level.id} value={level.id}>{level.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={handleQuickAdd}
                disabled={!newName.trim() || createMutation.isPending}
                data-testid="button-confirm-add-person"
              >
                {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onRequestQuickAdd}
        className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-cta hover:text-cta/80 hover:bg-accent/70 rounded-md transition-colors"
        data-testid="button-new-person-row"
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
        <span>New Person</span>
      </button>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : people.length === 0 && !searchQuery ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-no-people">No people yet.</div>
      ) : people.length === 0 && searchQuery ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-no-search-results">
          No matching people.
        </div>
      ) : (
        <div className="space-y-1">
          {surfacedItems.length > 0 && (
            <PeopleGroupSection
              label="Surface"
              count={surfacedItems.length}
              defaultOpen
              forceOpen={searchQuery.length > 0}
              testId="people-group-surface"
            >
              {surfacedItems.map(item => (
                <SurfacedPersonRow
                  key={item.id}
                  item={item}
                  dateLabel={surfacedDateLabel(item)}
                  onSurfaceChange={() => {
                    queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
                    queryClient.invalidateQueries({ queryKey: ["/api/people/agenda"] });
                  }}
                />
              ))}
            </PeopleGroupSection>
          )}
          {sortedLevels.map((level) => {
            const group = groupedPeople[level.id];
            if (!group || group.length === 0) return null;
            return (
              <PeopleGroupSection
                key={level.id}
                label={level.name}
                count={group.length}
                defaultOpen={false}
                forceOpen={searchQuery.length > 0}
                testId={`people-group-${level.id}`}
              >
                {group.map(renderPersonRow)}
              </PeopleGroupSection>
            );
          })}
          {searchQuery && (() => {
            const ungrouped = people.filter(person => !sortedLevels.some(level => level.id === person.cabinetLevel));
            if (ungrouped.length === 0) return null;
            return (
              <PeopleGroupSection label="Other" count={ungrouped.length} defaultOpen={false} testId="people-group-other">
                {ungrouped.map(renderPersonRow)}
              </PeopleGroupSection>
            );
          })()}
        </div>
      )}

      {isAdmin && (importPending > 0 || visibleImportCandidates.length > 0) && (
        <PeopleGroupSection
          label="IMPORT"
          count={importPending}
          defaultOpen
          forceOpen={searchQuery.length > 0}
          testId="people-group-import"
        >
          {visibleImportCandidates.map(candidate => {
            const selected = selectedImportEmail === candidate.email;
            return (
              <button
                key={candidate.email}
                type="button"
                className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left transition-colors overflow-hidden ${selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70"}`}
                onClick={() => onSelectImportCandidate?.(candidate.email)}
                data-testid={`candidate-row-${candidate.email}`}
              >
                <Mail className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate flex-1 min-w-0">{candidate.name || candidate.email.split("@")[0]}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{candidate.threadCount}t</span>
              </button>
            );
          })}
        </PeopleGroupSection>
      )}
    </div>
  );
}

function PeopleGroupSection({ label, count, defaultOpen, testId, forceOpen, children }: {
  label: string;
  count: number;
  defaultOpen: boolean;
  testId: string;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const storageKey = `people:list:${testId}:open`;
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return defaultOpen;
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return defaultOpen;
  });
  const effectiveOpen = forceOpen || open;
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (forceOpen) return;
    setOpen(nextOpen);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, String(nextOpen));
    }
  }, [forceOpen, storageKey]);

  return (
    <Collapsible open={effectiveOpen} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover-elevate rounded-md"
        data-testid={`button-toggle-${testId}`}
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${effectiveOpen ? "rotate-90" : ""}`} />
        {label} <span className="text-xs font-normal">({count})</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-0.5 mt-0.5">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function LogMonthSection({
  monthKey,
  label,
  defaultOpen,
  children,
}: {
  monthKey: string;
  label: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`log-month-${monthKey}`}>
      <CollapsibleTrigger className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover-elevate rounded-md">
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span>{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-0.5">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function InteractionsTab({ person, onUpdate, showAdd, setShowAdd }: { person: Person; onUpdate: () => void; showAdd?: boolean; setShowAdd?: (show: boolean) => void }) {
  const { toast } = useToast();
  const [localShowAdd, setLocalShowAdd] = useState(false);
  const effectiveShowAdd = showAdd ?? localShowAdd;
  const setEffectiveShowAdd = setShowAdd ?? setLocalShowAdd;
  const [newType, setNewType] = useState<string>("note");
  const [newSummary, setNewSummary] = useState("");
  const [newDate, setNewDate] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  });
  const [pendingDeleteLogItem, setPendingDeleteLogItem] = useState<{ kind: "interaction" | "note" | "memory"; id: string; label: string } | null>(null);
  const [deleteLogDialogOpen, setDeleteLogDialogOpen] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [newResponseOwed, setNewResponseOwed] = useState(false);
  const [newResponseDueBy, setNewResponseDueBy] = useState<string>("");
  const [savedInteractionId, setSavedInteractionId] = useState<string | null>(null);
  const summaryInputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastSavedPayloadRef = useRef<string>("");

  useEffect(() => {
    if (effectiveShowAdd) summaryInputRef.current?.focus();
  }, [effectiveShowAdd]);

  const addMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await apiRequest("POST", `/api/people/${person.id}/interactions`, data);
      return res.json();
    },
    onSuccess: (updatedPerson: Person) => {
      const createdInteraction = updatedPerson.interactions.at(-1);
      setSavedInteractionId((prev) => prev || createdInteraction?.id || null);
      queryClient.invalidateQueries({ queryKey: ["/api/people", person.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      onUpdate();
    },
    onError: (err: Error) => {
      lastSavedPayloadRef.current = "";
      toast({ title: "Failed to log interaction", description: err.message, variant: "destructive" });
    },
  });

  const updateInteractionMutation = useMutation({
    mutationFn: async ({ interactionId, data }: { interactionId: string; data: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/people/${person.id}/interactions/${interactionId}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/people", person.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      onUpdate();
    },
    onError: (err: Error) => {
      lastSavedPayloadRef.current = "";
      toast({ title: "Failed to update interaction", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (interactionId: string) => {
      const res = await apiRequest("DELETE", `/api/people/${person.id}/interactions/${interactionId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/people", person.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      toast({ title: "Interaction deleted" });
      onUpdate();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });


  const deleteNoteMutation = useMutation({
    mutationFn: async (noteId: string) => {
      const res = await apiRequest("DELETE", `/api/people/${person.id}/notes/${noteId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/people", person.id] });
      toast({ title: "Note deleted" });
      onUpdate();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete note", description: err.message, variant: "destructive" });
    },
  });


  const updateNoteMutation = useMutation({
    mutationFn: async ({ noteId, content, title }: { noteId: string; content: string; title?: string }) => {
      const res = await apiRequest("PATCH", `/api/people/${person.id}/notes/${noteId}`, { content, title });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/people", person.id] });
      toast({ title: "Note updated" });
      setEditingNoteId(null);
      setNoteDraft("");
      onUpdate();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update note", description: err.message, variant: "destructive" });
    },
  });

  const saveNoteDraft = (note: Note | null) => {
    if (!note) return;
    const next = noteDraft.trim();
    if (!next) return;
    if (next !== note.content) updateNoteMutation.mutate({ noteId: note.id, content: next, title: note.title });
    else setEditingNoteId(null);
  };


  useEffect(() => {
    const trimmed = newSummary.trim();
    if (!effectiveShowAdd || !trimmed) return;
    const timeout = window.setTimeout(() => {
      const data: Record<string, unknown> = { date: newDate, type: newType, summary: trimmed };
      if (newResponseOwed) {
        data.responseOwed = true;
        if (newResponseDueBy) data.responseDueBy = newResponseDueBy;
      }
      const payloadKey = JSON.stringify(data);
      if (payloadKey === lastSavedPayloadRef.current) return;
      if (savedInteractionId) {
        if (!updateInteractionMutation.isPending) {
          lastSavedPayloadRef.current = payloadKey;
          updateInteractionMutation.mutate({ interactionId: savedInteractionId, data });
        }
      } else if (!addMutation.isPending) {
        lastSavedPayloadRef.current = payloadKey;
        addMutation.mutate(data);
      }
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [addMutation, effectiveShowAdd, newDate, newResponseDueBy, newResponseOwed, newSummary, newType, savedInteractionId, updateInteractionMutation]);

  const closeNewLogDraft = () => {
    if (!newSummary.trim() || savedInteractionId) {
      setEffectiveShowAdd(false);
      setSavedInteractionId(null);
      setNewType("note");
      setNewSummary("");
      setNewResponseOwed(false);
      setNewResponseDueBy("");
      lastSavedPayloadRef.current = "";
    }
  };


  const interactionPatch = (interaction: Interaction, updates: Record<string, unknown>) => {
    updateInteractionMutation.mutate({ interactionId: interaction.id, data: updates });
  };

  const ensureFollowUpDueDate = (current?: string) => {
    if (current) return current;
    const d = new Date();
    d.setDate(d.getDate() + 3);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const interactionTypeLabels: Record<string, string> = { note: "Note", call: "Call", meeting: "Meeting", meetup: "Meetup", email: "Email", text: "Text", in_person: "In Person" };

  const renderInteractionOptions = (interaction: Interaction) => (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Type: {interactionTypeLabels[interaction.type || "note"] || "Note"}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {Object.entries(interactionTypeLabels).map(([value, label]) => (
            <DropdownMenuItem key={value} onClick={() => interactionPatch(interaction, { type: value })}>
              {interaction.type === value ? `\u2713 ${label}` : label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="p-0">
        <InlineDatePicker
          value={interaction.date?.slice(0, 10) || ""}
          onCommit={(v) => { if (v) interactionPatch(interaction, { date: v }); }}
          className="w-full px-2 py-1.5"
          expandHitArea={false}
          testId={`input-log-date-${interaction.id}`}
        >
          <span>Date: {interaction.date ? new Date(`${interaction.date.slice(0, 10)}T12:00:00`).toLocaleDateString() : "Not set"}</span>
        </InlineDatePicker>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => {
        const next = !interaction.responseOwed;
        interactionPatch(interaction, { responseOwed: next, responseDueBy: next ? ensureFollowUpDueDate(interaction.responseDueBy) : null });
      }}>
        {interaction.responseOwed ? "\u2713 Follow-up" : "Follow-up"}
      </DropdownMenuItem>
      {interaction.responseOwed && (
        <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="p-0">
          <InlineDatePicker
            value={interaction.responseDueBy?.slice(0, 10) || ""}
            onCommit={(v) => { if (v) interactionPatch(interaction, { responseDueBy: v }); }}
            className="w-full px-2 py-1.5"
            expandHitArea={false}
            testId={`input-log-follow-up-date-${interaction.id}`}
          >
            <span>Due: {interaction.responseDueBy ? fromCivilDate(interaction.responseDueBy.slice(0, 10)).toLocaleDateString() : "Not set"}</span>
          </InlineDatePicker>
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="text-destructive focus:text-destructive"
        onClick={() => {
          setPendingDeleteLogItem({ kind: "interaction", id: interaction.id, label: interaction.summary || "Log item" });
          setDeleteLogDialogOpen(true);
        }}
      >
        Delete
      </DropdownMenuItem>
    </>
  );

  const { data: linkedMemories = [] } = useQuery<LinkedMemoryEntry[]>({
    queryKey: ["/api/memory/entity-links", "person", person.id],
    queryFn: async () => {
      const res = await fetch(`/api/memory/entity-links/person/${person.id}`);
      if (!res.ok) throw new Error("Failed to fetch linked memories");
      return res.json();
    },
  });

  const { data: relationshipMemories = [] } = useQuery<RelationshipMemory[]>({
    queryKey: ["/api/people", person.id, "relationship-memories"],
    queryFn: async () => {
      const res = await fetch(`/api/people/${person.id}/relationship-memories`);
      if (!res.ok) throw new Error("Failed to fetch relationship memories");
      return res.json();
    },
  });

  const unlinkMemoryMutation = useMutation({
    mutationFn: async (memoryId: number) => {
      await apiRequest("DELETE", `/api/memory/entity-links/${memoryId}/person/${person.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/memory/entity-links", "person", person.id] });
      toast({ title: "Memory unlinked" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to unlink memory", description: err.message, variant: "destructive" });
    },
  });

  const sorted = useMemo(() => {
    const interactionItems = person.interactions.map((interaction) => ({ kind: "interaction" as const, id: interaction.id, date: interaction.date, interaction }));
    const noteItems = person.notes.map((note) => ({ kind: "note" as const, id: note.id, date: note.createdAt, note }));
    const memoryItems = linkedMemories.map((memory) => ({ kind: "memory" as const, id: String(memory.id), date: memory.createdAt || new Date(0).toISOString(), memory }));
    const relationshipMemoryItems = relationshipMemories.map((relationshipMemory) => ({ kind: "relationshipMemory" as const, id: relationshipMemory.id, date: relationshipMemory.createdAt || new Date(0).toISOString(), relationshipMemory }));
    return [...interactionItems, ...noteItems, ...memoryItems, ...relationshipMemoryItems].sort((a, b) => parseDateString(b.date).getTime() - parseDateString(a.date).getTime());
  }, [person.interactions, person.notes, linkedMemories, relationshipMemories]);

  const monthGroups = useMemo(() => {
    const groups: Array<{ monthKey: string; label: string; defaultOpen: boolean; items: typeof sorted }> = [];
    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonthKey = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}`;

    sorted.forEach((item) => {
      const d = parseDateString(item.date);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      let group = groups.find((entry) => entry.monthKey === monthKey);
      if (!group) {
        group = {
          monthKey,
          label: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
          defaultOpen: monthKey === currentMonthKey || monthKey === previousMonthKey,
          items: [],
        };
        groups.push(group);
      }
      group.items.push(item);
    });

    return groups;
  }, [sorted]);

  return (
    <div className="space-y-3" data-testid="interactions-tab">
      {effectiveShowAdd ? (
        <div className="max-h-80 max-w-none overflow-auto rounded-xl rounded-bl-sm border border-primary/20 bg-card/70 px-3 py-2 text-[14px] leading-tight text-white scrollbar-thin">
          <div className="flex items-start gap-2">
            <Textarea
              ref={summaryInputRef}
              value={newSummary}
              onChange={(e) => setNewSummary(e.target.value)}
              placeholder="What happened?"
              className="min-h-24 w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-tight text-white shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-[14px]"
              data-testid="textarea-interaction-summary"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
                  aria-label="Log options"
                  data-testid="button-new-log-options"
                >
                  <MoreHorizontal className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Type: {interactionTypeLabels[newType] || "Note"}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {Object.entries(interactionTypeLabels).map(([value, label]) => (
                      <DropdownMenuItem key={value} onClick={() => setNewType(value)}>
                        {newType === value ? "\u2713 " + label : label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="p-0">
                  <InlineDatePicker
                    value={newDate}
                    onCommit={(v) => { if (v) setNewDate(v); }}
                    className="w-full px-2 py-1.5"
                    expandHitArea={false}
                    testId="input-interaction-date"
                  >
                    <span>Date: {newDate ? new Date(newDate + "T12:00").toLocaleDateString() : "Today"}</span>
                  </InlineDatePicker>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => {
                  const next = !newResponseOwed;
                  setNewResponseOwed(next);
                  if (next && !newResponseDueBy) {
                    const d = new Date();
                    d.setDate(d.getDate() + 3);
                    setNewResponseDueBy(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
                  }
                }}>
                  {newResponseOwed ? "\u2713 Follow-up" : "Follow-up"}
                </DropdownMenuItem>
                {newResponseOwed && (
                  <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="p-0">
                    <InlineDatePicker
                      value={newResponseDueBy}
                      onCommit={(v) => { if (v) setNewResponseDueBy(v); }}
                      className="w-full px-2 py-1.5"
                      expandHitArea={false}
                      testId="input-response-due-by"
                    >
                      <span>Due: {newResponseDueBy ? new Date(newResponseDueBy + "T12:00").toLocaleDateString() : "Not set"}</span>
                    </InlineDatePicker>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEffectiveShowAdd(true)}
          className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-cta hover:text-cta/80 hover:bg-accent/70 rounded-md transition-colors"
          data-testid="button-new-log"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New Log</span>
        </button>
      )}

      {sorted.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border/20" data-testid="interaction-tree">
          {monthGroups.map((group) => (
            <LogMonthSection key={group.monthKey} monthKey={group.monthKey} label={group.label} defaultOpen={group.defaultOpen}>
              {group.items.map((item) => {
            const isNote = item.kind === "note";
            const isMemory = item.kind === "memory";
            const isRelationshipMemory = item.kind === "relationshipMemory";
            const interaction = item.kind === "interaction" ? item.interaction : null;
            const note = isNote ? item.note : null;
            const memory = isMemory ? item.memory : null;
            const relationshipMemory = isRelationshipMemory ? item.relationshipMemory : null;
            const Icon = isNote ? FileText : (isMemory || isRelationshipMemory) ? Brain : INTERACTION_ICONS[interaction?.type || ""] || MessageSquare;
            const d = parseDateString(item.date);
            const DirectionIcon = interaction?.direction === "inbound" ? ArrowDownLeft : interaction?.direction === "outbound" ? ArrowUpRight : null;
            const title = d.toLocaleDateString("en-US", { month: "numeric", day: "2-digit" });
            const memoryTitle = memory?.title || memory?.summary || memory?.content || "Memory";
            const relationshipMemoryTitle = relationshipMemory?.title || relationshipMemory?.content || "Relationship memory";
            const noteTitle = note?.title && note.title !== "Untitled" ? note.title : null;
            const preview = isNote ? (noteTitle || note?.content || "Note") : isMemory ? memoryTitle : isRelationshipMemory ? relationshipMemoryTitle : (interaction?.summary || "");
            if (interaction) {
              return (
                <ExpandableInteractionRow
                  key={`interaction-${item.id}`}
                  interaction={interaction}
                  menuContent={renderInteractionOptions(interaction)}
                  testId={`interaction-${item.id}`}
                  mobileLayout="inline"
                />
              );
            }
            return (
              <Fragment key={`${item.kind}-${item.id}`}>
                <ProfileTreeRow
                  label={<span>{title}</span>}
                  icon={<Icon className="h-3.5 w-3.5 text-muted-foreground" />}
                  hasValue
                  showEmpty
                  expandedContent={(
                    <div className="max-h-80 max-w-none overflow-auto rounded-xl rounded-bl-sm border border-primary/20 bg-card/70 px-3 py-2 text-[14px] leading-tight text-white scrollbar-thin">
                      {isNote ? (
                        <div>
                          {editingNoteId === item.id ? (
                            <Textarea
                              value={noteDraft}
                              onChange={(event) => setNoteDraft(event.target.value)}
                              onBlur={() => saveNoteDraft(note)}
                              onKeyDown={(event) => {
                                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveNoteDraft(note);
                                if (event.key === "Escape") { setEditingNoteId(null); setNoteDraft(""); }
                              }}
                              className="min-h-24 w-full resize-none border-0 bg-transparent p-0 text-xs leading-relaxed text-white shadow-none outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-xs"
                              data-testid={`textarea-note-log-${item.id}`}
                            />
                          ) : (
                            <button
                              type="button"
                              className="block w-full whitespace-pre-wrap text-left text-xs leading-relaxed text-white"
                              onClick={() => { setEditingNoteId(item.id); setNoteDraft(note?.content || ""); }}
                              data-testid={`note-log-content-${item.id}`}
                            >
                              {note?.content || note?.title || "Note"}
                            </button>
                          )}
                          {note?.updatedAt && note.updatedAt !== note.createdAt && <p className="mt-2 text-[10px] text-muted-foreground">edited {formatShortDate(note.updatedAt)}</p>}
                        </div>
                      ) : isMemory ? (
                        <div>
                          <p className="font-semibold text-white">{memoryTitle}</p>
                          {memory?.summary && memory.title && <p className="mt-2 whitespace-pre-wrap text-[14px] leading-tight text-white">{memory.summary}</p>}
                          <p className="mt-2 whitespace-pre-wrap text-[14px] leading-tight text-white">{memory?.content}</p>
                          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                            <Badge variant="outline" className="text-[10px] leading-none">{memory?.layer}</Badge>
                            <Badge variant="outline" className="text-[10px] leading-none">{memory?.source}</Badge>
                            {memory?.tags?.map((tag) => <Badge key={tag} variant="outline" className="text-[10px] leading-none">{tag}</Badge>)}
                          </div>
                        </div>
                      ) : isRelationshipMemory ? (
                        <div>
                          <p className="font-semibold text-white">{relationshipMemoryTitle}</p>
                          <p className="mt-2 whitespace-pre-wrap text-[14px] leading-tight text-white">{relationshipMemory?.content}</p>
                          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                            {relationshipMemory?.category && <Badge variant="outline" className="text-[10px] leading-none">{RM_CATEGORY_MAP[relationshipMemory.category]?.label || relationshipMemory.category}</Badge>}
                            {relationshipMemory?.tags?.map((tag) => <Badge key={tag} variant="outline" className="text-[10px] leading-none">{tag}</Badge>)}
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="whitespace-pre-wrap text-[14px] leading-tight text-white" data-testid={`interaction-summary-${item.id}`}>{interaction?.summary}</p>
                          {interaction?.context && <p className="mt-2 whitespace-pre-wrap text-[14px] leading-tight text-white">{interaction.context}</p>}
                          {(interaction?.capitalImpact && interaction.capitalImpact !== "neutral") || interaction?.responseOwed || interaction?.responseDueBy || interaction?.tags?.length ? (
                            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                              {interaction?.capitalImpact && interaction.capitalImpact !== "neutral" && <span>{interaction.capitalImpact}</span>}
                              {interaction?.responseOwed && <span className="text-foreground">follow-up</span>}
                              {interaction?.responseDueBy && <span>due {formatShortDate(interaction.responseDueBy)}</span>}
                              {interaction?.tags?.map((tag) => <span key={tag}>{tag}</span>)}
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  )}
                  expandedContentClassName="px-2 pb-2 pl-2"
                  mobileLayout="inline"
                  menuContent={interaction ? renderInteractionOptions(interaction) : !isRelationshipMemory ? (
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => {
                        setPendingDeleteLogItem({ kind: isNote ? "note" : "memory", id: item.id, label: preview });
                        setDeleteLogDialogOpen(true);
                      }}
                    >
                      Delete
                    </DropdownMenuItem>
                  ) : undefined}
                  testId={`${item.kind}-${item.id}`}
                >
                  <div className="flex w-full min-w-0 items-center justify-start gap-1.5 sm:justify-end">
                    <span className={cn("truncate text-xs", interaction?.responseOwed ? "text-foreground" : "text-muted-foreground")} data-testid={`log-preview-${item.id}`}>{preview}</span>
                    {DirectionIcon && <DirectionIcon className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={interaction?.direction || undefined} />}
                  </div>
                </ProfileTreeRow>
              </Fragment>
            );
              })}
            </LogMonthSection>
          ))}        </div>
      )}

      <AlertDialog
        open={deleteLogDialogOpen}
        onOpenChange={(open) => {
          setDeleteLogDialogOpen(open);
          if (!open) window.setTimeout(() => setPendingDeleteLogItem(null), 0);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete log item?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete “{pendingDeleteLogItem?.label}”. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                const target = pendingDeleteLogItem;
                if (!target) return;
                setDeleteLogDialogOpen(false);
                window.setTimeout(() => {
                  if (target.kind === "note") deleteNoteMutation.mutate(target.id);
                  else if (target.kind === "memory") unlinkMemoryMutation.mutate(Number(target.id));
                  else deleteMutation.mutate(target.id);
                  setPendingDeleteLogItem(null);
                }, 0);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DatesTab({ person, onUpdate }: { person: Person; onUpdate: () => void }) {
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newDate, setNewDate] = useState("");
  const [newRecurrence, setNewRecurrence] = useState<"annual" | "one-time">("annual");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);

  const summaryInputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (effectiveShowAdd) summaryInputRef.current?.focus();
  }, [effectiveShowAdd]);

  const addMutation = useMutation({
    mutationFn: async (data: { label: string; date: string; recurrence: "annual" | "one-time" }) => {
      const res = await apiRequest("POST", `/api/people/${person.id}/dates`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/people", person.id] });
      setShowAdd(false);
      setNewLabel("");
      setNewDate("");
      onUpdate();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add date", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (dateId: string) => {
      const res = await apiRequest("DELETE", `/api/people/${person.id}/dates/${dateId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/people", person.id] });
      onUpdate();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete date", description: err.message, variant: "destructive" });
    },
  });

  const sortedDates = useMemo(() => {
    const now = new Date();
    return [...person.importantDates].sort((a, b) => {
      const aDate = parseDateString(a.date);
      const bDate = parseDateString(b.date);
      if (a.recurrence === "annual") {
        aDate.setFullYear(now.getFullYear());
        if (aDate < now) aDate.setFullYear(now.getFullYear() + 1);
      }
      if (b.recurrence === "annual") {
        bDate.setFullYear(now.getFullYear());
        if (bDate < now) bDate.setFullYear(now.getFullYear() + 1);
      }
      return aDate.getTime() - bDate.getTime();
    });
  }, [person.importantDates]);

  return (
    <div className="space-y-3" data-testid="dates-tab">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{sortedDates.length} date{sortedDates.length !== 1 ? "s" : ""}</span>
        <Button variant="outline" size="sm" onClick={() => setShowAdd(!showAdd)} data-testid="button-add-date">
          <Plus className="h-3.5 w-3.5 mr-1" /> Add
        </Button>
      </div>

      {showAdd && (
        <Card>
          <CardContent className="pt-3 pb-2 space-y-2">
            <div className="flex gap-2 flex-wrap">
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. Birthday"
                className="flex-1 min-w-[120px]"
                data-testid="input-date-label"
              />
              <Input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className="w-48"
                data-testid="input-date-value"
              />
              <Select value={newRecurrence} onValueChange={(v) => setNewRecurrence(v as "annual" | "one-time")}>
                <SelectTrigger className="w-28" data-testid="select-date-recurrence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="annual">Annual</SelectItem>
                  <SelectItem value="one-time">One-time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-1 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button
                size="sm"
                onClick={() => addMutation.mutate({ label: newLabel, date: newDate, recurrence: newRecurrence })}
                disabled={!newLabel.trim() || !newDate || addMutation.isPending}
                data-testid="button-save-date"
              >
                Save
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {sortedDates.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center" data-testid="text-no-dates">
          No important dates. Click "Add" to track birthdays, anniversaries, and more.
        </p>
      ) : (
        <div className="space-y-1.5">
          {sortedDates.map((d) => {
            const dateObj = fromCivilDate(d.date);
            const now = new Date();
            let nextOccurrence = dateObj;
            if (d.recurrence === "annual") {
              nextOccurrence = new Date(dateObj);
              nextOccurrence.setFullYear(now.getFullYear());
              if (nextOccurrence < now) nextOccurrence.setFullYear(now.getFullYear() + 1);
            }
            const daysUntil = Math.ceil((nextOccurrence.getTime() - now.getTime()) / 86400000);
            const isUpcoming = daysUntil >= 0 && daysUntil <= 14;

            return (
              <div key={d.id} className="flex items-center gap-2 group py-1 px-1 rounded-md hover-elevate" data-testid={`date-${d.id}`}>
                <Calendar className={`h-3.5 w-3.5 shrink-0 ${isUpcoming ? "text-warning" : "text-muted-foreground"}`} />
                <div className="flex-1 min-w-0">
                  <span className="text-sm">{d.label}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    {formatShortDate(d.date)}
                    {d.recurrence === "annual" && " (annual)"}
                  </span>
                </div>
                {isUpcoming && (
                  <Badge variant="secondary" className="text-xs shrink-0">
                    {daysUntil === 0 ? "Today" : daysUntil === 1 ? "Tomorrow" : `In ${daysUntil}d`}
                  </Badge>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => setDeleteTarget({ id: d.id, label: d.label })}
                  data-testid={`button-delete-date-${d.id}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete date</AlertDialogTitle>
            <AlertDialogDescription>Remove "{deleteTarget?.label}"?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function IdentityTab({ person, onUpdate }: { person: Person; onUpdate: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(person.identityContent || "");

  useEffect(() => {
    setContent(person.identityContent || "");
  }, [person.id, person.identityContent]);

  const saveMutation = useMutation({
    mutationFn: async (identityContent: string) => {
      const res = await apiRequest("PUT", `/api/people/${person.id}/identity`, { identityContent });
      return res.json();
    },
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["/api/people", person.id] });
      onUpdate();
      toast({ title: "Identity saved" });
    },
    onError: () => {
      toast({ title: "Failed to save identity", variant: "destructive" });
    },
  });

  const migrateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/people/migrate-identity");
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/people", person.id] });
      onUpdate();
      const migrated = (data.xyzMigrated ? getInstanceName() : "") + (data.partnerMigrated ? (data.xyzMigrated ? " & Partner" : "Partner") : "");
      toast({ title: migrated ? `Migrated: ${migrated}` : "No documents to migrate (already migrated or no source documents found)" });
    },
    onError: () => {
      toast({ title: "Migration failed", variant: "destructive" });
    },
  });

  return (
    <div className="space-y-3" data-testid="identity-tab">
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between gap-1">
          <CardTitle className="text-sm font-medium">Identity Document</CardTitle>
          <div className="flex items-center gap-1 flex-wrap">
            {!person.identityContent && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => migrateMutation.mutate()}
                disabled={migrateMutation.isPending}
                data-testid="button-migrate-identity"
              >
                {migrateMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                Migrate from Documents
              </Button>
            )}
            {!editing ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                data-testid="button-edit-identity"
              >
                <Edit3 className="h-3.5 w-3.5 mr-1.5" /> Edit
              </Button>
            ) : (
              <div className="flex gap-1 flex-wrap">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setEditing(false); setContent(person.identityContent || ""); }}
                  data-testid="button-cancel-identity"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => saveMutation.mutate(content)}
                  disabled={saveMutation.isPending}
                  data-testid="button-save-identity"
                >
                  {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                  Save
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[300px] font-mono text-sm"
              data-testid="input-identity-content"
            />
          ) : person.identityContent ? (
            <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-sm" data-testid="text-identity-content">
              {person.identityContent}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center" data-testid="text-identity-empty">
              No identity document set for this person. Click "Edit" to write one, or "Migrate from Documents" to import from SOUL.md / USER.md.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AnalysisTab({ person }: { person: Person }) {
  const hasData = person.interactions.length > 0 || person.notes.length > 0;

  const interactionBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const i of person.interactions) {
      counts[i.type] = (counts[i.type] || 0) + 1;
    }
    return counts;
  }, [person.interactions]);

  const avgFrequency = useMemo(() => {
    if (person.interactions.length < 2) return null;
    const sorted = [...person.interactions].sort((a, b) => parseDateString(a.date).getTime() - parseDateString(b.date).getTime());
    const first = parseDateString(sorted[0].date).getTime();
    const last = parseDateString(sorted[sorted.length - 1].date).getTime();
    const days = (last - first) / 86400000;
    if (days === 0) return null;
    return Math.round(days / (sorted.length - 1));
  }, [person.interactions]);

  return (
    <div className="space-y-4" data-testid="analysis-tab">
      {person.private ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Shield className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground" data-testid="text-analysis-private">
              AI analysis is disabled for this person. Toggle privacy in profile settings to enable.
            </p>
          </CardContent>
        </Card>
      ) : !hasData ? (
        <Card>
          <CardContent className="py-8 text-center">
            <TrendingUp className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground" data-testid="text-analysis-no-data">
              Add interactions and notes to unlock behavioral analysis and predictions.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Communication Patterns
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {Object.entries(interactionBreakdown).map(([type, count]) => {
                  const Icon = INTERACTION_ICONS[type] || MessageSquare;
                  return (
                    <div key={type} className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-sm capitalize flex-1">{type}</span>
                      <span className="text-sm font-mono tabular-nums">{count}</span>
                    </div>
                  );
                })}
                {avgFrequency !== null && (
                  <div className="flex items-center gap-2 pt-2 border-t">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm flex-1">Avg. frequency</span>
                    <span className="text-sm font-mono tabular-nums">Every {avgFrequency}d</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <PredictiveInsightsCard person={person} />
        </>
      )}
    </div>
  );
}

function PredictiveInsightsCard({ person }: { person: Person }) {
  const [summary, setSummary] = useState<string | null>(person.aiSummary || null);

  useEffect(() => {
    setSummary(person.aiSummary || null);
  }, [person.id, person.aiSummary]);

  const { toast } = useToast();
  const summarizeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/people/${person.id}/summarize`);
      const data = await res.json();
      return data.summary as string;
    },
    onSuccess: (data) => {
      setSummary(data);
      queryClient.invalidateQueries({ queryKey: ["/api/people", person.id] });
    },
    onError: (err: Error) => {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          Predictive Insights
        </CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() => summarizeMutation.mutate()}
          disabled={summarizeMutation.isPending}
          data-testid="button-summarize-person"
        >
          {summarizeMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Sparkles className="h-3 w-3 mr-1" />}
          {summary ? "Refresh" : "Analyze"}
        </Button>
      </CardHeader>
      <CardContent>
        {summarizeMutation.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-summarize-loading">
            <Loader2 className="h-4 w-4 animate-spin" />
            Analyzing {person.name}...
          </div>
        ) : summary ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap" data-testid="text-predictive-summary">{summary}</p>
        ) : summarizeMutation.isError ? (
          <p className="text-sm text-destructive" data-testid="text-summarize-error">
            Failed to generate analysis. Try again.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="text-predictive-placeholder">
            Tap Analyze to generate a predictive behavioral model of {person.name} based on all available data — profile, identity, notes, interactions, and linked memories.
          </p>
        )}
      </CardContent>
    </Card>
  );
}


function CombinedRelationshipPicker({
  person,
  onUpdate,
}: {
  person: Person;
  onUpdate: (updates: Partial<Person>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedProfessional = person.professionalRelations || [];
  const selected = [...(person.relation ? [person.relation] : []), ...selectedProfessional];
  const options = Array.from(new Set([...RELATION_OPTIONS, ...PROFESSIONAL_RELATION_OPTIONS, ...selected])).sort((a, b) => a.localeCompare(b));
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = options.filter(option => option.toLowerCase().includes(normalizedQuery));
  const exactMatch = options.some(option => option.toLowerCase() === normalizedQuery);

  const removeValue = (value: string) => {
    if (person.relation === value) onUpdate({ relation: "" });
    else onUpdate({ professionalRelations: selectedProfessional.filter(item => item !== value) });
  };

  const addValue = (value: string) => {
    const next = value.trim();
    if (!next) return;
    if (RELATION_OPTIONS.includes(next)) {
      onUpdate({ relation: person.relation === next ? "" : next });
    } else if (selectedProfessional.includes(next)) {
      onUpdate({ professionalRelations: selectedProfessional.filter(item => item !== next) });
    } else if (person.relation !== next) {
      onUpdate({ professionalRelations: [...selectedProfessional, next] });
    }
    setQuery("");
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex h-5 w-48 items-center justify-end gap-1 overflow-hidden rounded border border-input bg-muted/50 px-1.5 text-right text-xs" data-testid="button-relationship-picker">
          <span className="truncate">{selected.length > 0 ? selected.join(", ") : "Add relationship"}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-2" onCloseAutoFocus={(event) => event.preventDefault()}>
        {selected.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {selected.map((value) => (
              <Badge key={value} variant="outline" className="gap-1 text-[10px]">
                <span className="max-w-[10rem] truncate">{value}</span>
                <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); removeValue(value); }} aria-label={`Remove ${value}`}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              addValue(query);
            }
          }}
          placeholder="Type to search or add"
          className="mb-1 h-7 w-full text-left text-xs"
          data-testid="input-relationship-search"
        />
        <div className="max-h-48 overflow-y-auto py-1">
          {filteredOptions.map((option) => {
            const active = selected.includes(option);
            return (
              <DropdownMenuItem key={option} onClick={() => addValue(option)} className="gap-2">
                <CheckCircle2 className={cn("h-3.5 w-3.5", active ? "text-cta" : "text-muted-foreground/30")} />
                <span className="truncate">{option}</span>
              </DropdownMenuItem>
            );
          })}
          {query.trim() && !exactMatch && (
            <DropdownMenuItem onClick={() => addValue(query)} className="gap-2 text-muted-foreground">
              <Plus className="h-3.5 w-3.5" />
              <span>Add “{query.trim()}”</span>
            </DropdownMenuItem>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProfileSummaryEditor({
  person,
  onSave,
}: {
  person: Person;
  onSave: (updates: Partial<Person>) => void;
}) {
  const [draft, setDraft] = useState(person.quickSummary || "");

  useEffect(() => {
    setDraft(person.quickSummary || "");
  }, [person.id, person.quickSummary]);

  const save = () => {
    const next = draft.trim();
    if (next !== (person.quickSummary || "")) {
      onSave({ quickSummary: next || undefined });
    }
  };

  return (
    <div className="max-h-80 max-w-none overflow-auto rounded-xl rounded-bl-sm border border-primary/20 bg-card/70 px-3 py-2 text-[14px] leading-tight text-white scrollbar-thin">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        placeholder="Add summary"
        className="min-h-24 w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-tight text-white shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-[14px]"
        data-testid="textarea-quick-summary"
      />
    </div>
  );
}

interface LinkedMemoryEntry {
  id: number;
  content: string;
  title?: string;
  summary?: string;
  layer: string;
  source: string;
  sourceId?: string;
  tags?: string[];
  createdAt?: string;
  metadata?: Record<string, unknown>;
  linkId: number;
}

const RM_CATEGORY_MAP: Record<string, { label: string; icon: string }> = {
  "dynamic": { label: "Dynamics", icon: "🔄" },
  "preference": { label: "Preferences", icon: "💡" },
  "channel": { label: "Channels", icon: "📡" },
  "expertise": { label: "Expertise", icon: "🎯" },
  "network": { label: "Network", icon: "🌐" },
  "capital": { label: "Capital", icon: "🤝" },
  "risk": { label: "Risks", icon: "⚠️" },
  "repair": { label: "Repairs", icon: "🔧" },
  "ritual": { label: "Rituals", icon: "📅" },
  "opportunity": { label: "Opportunities", icon: "✨" },
};

interface RelationshipMemory {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  createdAt: string | null;
  personName: string | null;
}

function isPersonModelEntry(memory: LinkedMemoryEntry): boolean {
  return memory.tags?.includes("person-model") ?? false;
}

function getPersonModelCategory(memory: LinkedMemoryEntry): { tag: string; label: string } | null {
  if (!memory.tags) return null;
  for (const tag of memory.tags) {
    if (tag.startsWith("pm-cat:") && PM_CATEGORY_MAP[tag]) {
      return { tag, label: PM_CATEGORY_MAP[tag].label };
    }
  }
  return null;
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.7) return "bg-success";
  if (confidence >= 0.4) return "bg-warning";
  return "bg-error";
}

function CommitmentsCard({ person, onUpdate }: { person: Person; onUpdate: () => void }) {
  const commitments = person.networkProfile?.commitments || [];
  const open = commitments.filter(c => c.status === "open");
  const resolved = commitments.filter(c => c.status !== "open");

  if (commitments.length === 0) return null;

  return (
    <Card data-testid="commitments-card">
      <CardContent className="py-3 px-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Commitments
        </span>
        {open.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {open.map(c => {
              const age = Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 86400000);
              return (
                <div key={c.id} className="flex items-start gap-2 text-sm" data-testid={`commitment-${c.id}`}>
                  <span className={`shrink-0 text-xs mt-0.5 ${c.direction === "from_ray" ? "text-info-foreground" : "text-warning-foreground"}`}>
                    {c.direction === "from_ray" ? "→" : "←"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">{c.description}</p>
                    <span className="text-xs text-muted-foreground">
                      {c.direction === "from_ray" ? "Ray promised" : "They offered"} · {age}d ago
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {resolved.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground mt-2 hover:text-foreground" data-testid="toggle-resolved-commitments">
              <ChevronRight className="h-3 w-3" />
              {resolved.length} resolved
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 space-y-1 opacity-60">
                {resolved.map(c => (
                  <div key={c.id} className="flex items-center gap-2 text-xs text-muted-foreground line-through">
                    <span>{c.direction === "from_ray" ? "→" : "←"}</span>
                    <span className="truncate">{c.description}</span>
                    <Badge variant="outline" className="text-xs shrink-0">{c.status}</Badge>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectionsCard({ person }: { person: Person }) {
  const connections = person.networkProfile?.connections || [];
  if (connections.length === 0) return null;

  return (
    <Card data-testid="connections-card">
      <CardContent className="py-3 px-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Network Connections
        </span>
        <div className="mt-2 space-y-1.5">
          {connections.map((conn, i) => (
            <div key={i} className="flex items-center gap-2 text-sm" data-testid={`connection-${i}`}>
              <Users className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="font-medium">{conn.name}</span>
              <span className="text-xs text-muted-foreground">({conn.relationship})</span>
              {conn.domain && <Badge variant="outline" className="text-xs">{conn.domain}</Badge>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function PersonDetailView({ personId, onClose, onDelete, openNewInteraction, onNewInteractionOpened }: {
  personId: string;
  onClose: () => void;
  onDelete: () => void;
  openNewInteraction?: boolean;
  onNewInteractionOpened?: () => void;
}) {
  const { toast } = useToast();
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [pendingContactDeleteIndex, setPendingContactDeleteIndex] = useState<number | null>(null);
  const [showAddContact, setShowAddContact] = useState(false);
  const [newContactType, setNewContactType] = useState<"email" | "phone" | "social" | "other">("email");
  const [newContactLabel, setNewContactLabel] = useState("");
  const [newContactValue, setNewContactValue] = useState("");
  const [addingNickname, setAddingNickname] = useState(false);
  const [newNickname, setNewNickname] = useState("");
  const [introducedBySearch, setIntroducedBySearch] = useState("");
  const [showIntroducedBySearch, setShowIntroducedBySearch] = useState(false);
  const [relationSearch, setRelationSearch] = useState("");
  const [showRelationSearch, setShowRelationSearch] = useState(false);
  const [editingRole, setEditingRole] = useState(false);
  const [editingInstagram, setEditingInstagram] = useState(false);
  const [editingX, setEditingX] = useState(false);
  const [editingLinkedin, setEditingLinkedin] = useState(false);
  const [editingMet, setEditingMet] = useState(false);
  const [editingFamiliarity, setEditingFamiliarity] = useState(false);
  const [editingTrust, setEditingTrust] = useState(false);
  const [showEmptyProfileRows, setShowEmptyProfileRows] = useState(false);
  const [showNewLog, setShowNewLog] = useState(false);

  const { data: person, isLoading } = useQuery<Person>({
    queryKey: ["/api/people", personId],
  });

  useFocusContext({
    entity: { type: "person", id: personId, label: person?.name },
    subView: "detail",
  });

  const { data: cabinetData } = useQuery<CabinetConfig>({
    queryKey: ["/api/people/cabinet-config"],
  });

  const { data: allPeopleData } = useQuery<{ people: PersonIndex[] }>({
    queryKey: ["/api/people"],
  });

  useEffect(() => {
    if (person) setEditName(person.name || "");
  }, [person?.id, person?.name]);

  useEffect(() => {
    setShowEmptyProfileRows(false);
  }, [personId]);

  useEffect(() => {
    if (!openNewInteraction) return;
    setShowNewLog(true);
    onNewInteractionOpened?.();
  }, [onNewInteractionOpened, openNewInteraction]);

  const introducedByPerson = useMemo(() => {
    if (!person?.introducedBy || !allPeopleData?.people) return null;
    return allPeopleData.people.find(p => p.id === person.introducedBy);
  }, [person?.introducedBy, allPeopleData?.people]);

  const filteredPeopleForIntroduction = useMemo(() => {
    if (!allPeopleData?.people || !person) return [];
    return allPeopleData.people
      .filter(p => p.id !== person.id && p.name.toLowerCase().includes(introducedBySearch.toLowerCase()))
      .slice(0, 8);
  }, [allPeopleData?.people, person, introducedBySearch]);

  const updateMutation = useMutation({
    mutationFn: async (updates: Partial<Person>) => {
      const res = await apiRequest("PATCH", `/api/people/${personId}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/people", personId] });
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      setEditingName(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/people/${personId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["/api/people", personId] });
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      onDelete();
      toast({ title: "Person deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });

  const levels = cabinetData?.levels || [];
  const sortedLevels = useMemo(() => [...levels].sort((a, b) => a.order - b.order), [levels]);

  const handleRefetch = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/people", personId] });
  }, [personId]);

  const handleAddNickname = useCallback(() => {
    if (!newNickname.trim() || !person) return;
    updateMutation.mutate({ nicknames: [...person.nicknames, newNickname.trim()] });
    setNewNickname("");
    setAddingNickname(false);
  }, [newNickname, person, updateMutation]);

  const handleRemoveNickname = useCallback((index: number) => {
    if (!person) return;
    const updated = person.nicknames.filter((_, i) => i !== index);
    updateMutation.mutate({ nicknames: updated });
  }, [person, updateMutation]);

  const handleSaveSocial = useCallback((platform: keyof SocialProfiles, value: string) => {
    if (!person) return;
    updateMutation.mutate({
      socialProfiles: { ...person.socialProfiles, [platform]: value || undefined },
    });
  }, [person, updateMutation]);


  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!person) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-muted-foreground" data-testid="text-person-not-found">Person not found.</p>
          <Button variant="outline" className="mt-4" onClick={onClose} data-testid="button-back-not-found">
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to People
          </Button>
        </CardContent>
      </Card>
    );
  }

  const contactTypeLabels: Record<string, string> = {
    email: "Email",
    phone: "Phone",
    social: "Social",
    other: "Other",
  };

  return (
    <div className="space-y-6" data-testid="person-detail-view">
      <div className="space-y-0">
      <ProfileDetailSection
        title={editingName ? (
          <Input
            value={editName}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={() => {
              const next = editName.trim();
              if (next && next !== person.name) updateMutation.mutate({ name: next });
              else setEditName(person.name);
              setEditingName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") { setEditName(person.name); setEditingName(false); }
            }}
            placeholder="Name"
            className="h-auto w-full border-0 bg-transparent p-0 text-xs font-bold uppercase leading-none tracking-wider text-muted-foreground shadow-none outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
            data-testid="input-edit-profile-name"
          />
        ) : (
          <span
            className="block truncate text-xs font-bold uppercase leading-none tracking-wider text-muted-foreground"
            onDoubleClick={(event) => { event.stopPropagation(); setEditingName(true); }}
            data-testid="profile-name-heading"
          >
            {person.name}
          </span>
        )}
        headerAction={(
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0 rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                aria-label="Profile actions"
                data-testid="button-profile-overflow"
              >
                <MoreHorizontal className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuItem onClick={() => setEditingName(true)} data-testid="menu-edit-person-name">
                Edit Name
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowEmptyProfileRows(v => !v)} data-testid="menu-toggle-hidden-fields">
                <CheckCircle2 className={cn("mr-2 h-3.5 w-3.5", showEmptyProfileRows ? "text-cta" : "text-muted-foreground/30")} />
                {showEmptyProfileRows ? "Hide Hidden Fields" : "Show Hidden Fields"}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteConfirm(true)} data-testid="menu-delete-person">
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        testId="section-profile"
        collapsedContent={!person.private && person.quickSummary ? (
          <div className="text-[14px] leading-tight text-white/80 whitespace-pre-wrap" data-testid="profile-summary-collapsed">
            {person.quickSummary}
          </div>
        ) : undefined}
      >
        <div className="overflow-hidden rounded-md border border-border/20">
          {!person.private && (
            <div data-testid="row-profile-summary">
              <ProfileSummaryEditor person={person} onSave={(updates) => updateMutation.mutate(updates)} />
            </div>
          )}

          <ProfileTreeRow label={<span data-testid="label-alias">Alias</span>} icon={<ContactRound className="h-3.5 w-3.5" />} hasValue={person.nicknames.length > 0} showEmpty={showEmptyProfileRows || addingNickname} testId="row-profile-alias">
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
              {person.nicknames.map((nick, i) => (
                <Badge key={i} variant="outline" className="text-xs" data-testid={`badge-alias-${i}`}>{nick}<button className="ml-1 inline-flex" onClick={(e) => { e.stopPropagation(); handleRemoveNickname(i); }} data-testid={`button-remove-alias-${i}`}><X className="h-2.5 w-2.5" /></button></Badge>
              ))}
              {addingNickname ? (
                <div className="flex items-center gap-1"><Input value={newNickname} onChange={(e) => setNewNickname(e.target.value)} placeholder="Alias" className="h-8 w-28 text-right" autoFocus onKeyDown={(e) => { if (e.key === "Enter") handleAddNickname(); if (e.key === "Escape") setAddingNickname(false); }} data-testid="input-add-alias" /><Button size="sm" onClick={handleAddNickname} disabled={!newNickname.trim()} data-testid="button-save-alias">Add</Button><Button variant="ghost" size="icon" onClick={() => setAddingNickname(false)} data-testid="button-cancel-alias"><X className="h-3 w-3" /></Button></div>
              ) : <Button variant="ghost" size="icon" onClick={() => setAddingNickname(true)} data-testid="button-add-alias"><Plus className="h-3 w-3" /></Button>}
            </div>
          </ProfileTreeRow>

          <ProfileTreeRow label={<span data-testid="label-tags">Tags</span>} icon={<SlidersHorizontal className="h-3.5 w-3.5" />} hasValue={(person.tags || []).length > 0} showEmpty={showEmptyProfileRows} testId="row-profile-tags"><DetailTagPicker tags={person.tags || []} onChange={(newTags) => updateMutation.mutate({ tags: newTags })} /></ProfileTreeRow>

          <ProfileTreeRow
            label={<span data-testid="label-met">Met</span>}
            icon={<Calendar className="h-3.5 w-3.5" />}
            hasValue={Boolean(person.met)}
            showEmpty={showEmptyProfileRows || editingMet}
            actionContent={person.met || editingMet ? (
              <InlineDatePicker
                value={person.met || ""}
                onCommit={(v) => { updateMutation.mutate({ met: v || undefined }); setEditingMet(false); }}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground"
                  data-testid="button-met-calendar"
                >
                  <Calendar className="h-3 w-3" />
                </Button>
              </InlineDatePicker>
            ) : undefined}
            testId="row-profile-met"
          >
            {person.met || editingMet ? (
              <div className="flex justify-end">
                <Input
                  key={person.met || "new-met"}
                  type="text"
                  defaultValue={person.met || ""}
                  placeholder="YYYY-MM-DD"
                  autoFocus={editingMet}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== (person.met || "")) updateMutation.mutate({ met: v || undefined }); setEditingMet(false); }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { (e.target as HTMLInputElement).value = person.met || ""; setEditingMet(false); } }}
                  className="w-48 text-right"
                  data-testid="input-met"
                />
              </div>
            ) : <Button variant="ghost" size="icon" onClick={() => setEditingMet(true)} data-testid="button-add-met"><Plus className="h-3 w-3" /></Button>}
          </ProfileTreeRow>

          <ProfileTreeRow label={<span data-testid="label-company">Company</span>} icon={<Building2 className="h-3.5 w-3.5" />} hasValue={Boolean(person.company)} showEmpty={showEmptyProfileRows} testId="row-profile-company">
            <CompanyReferenceField value={person.companyId ? `@company:${person.companyId}` : person.company || ""} onCommit={(value) => {
              const match = value.match(/^@company:([^\s]+)$/);
              updateMutation.mutate(match ? { companyId: match[1] } : { company: value, companyId: "" });
            }} />
          </ProfileTreeRow>

          <ProfileTreeRow label={<span data-testid="label-role">Role</span>} icon={<ContactRound className="h-3.5 w-3.5" />} hasValue={Boolean(person.role)} showEmpty={showEmptyProfileRows || editingRole} testId="row-profile-role">
            <Input key={person.role || "new-role"} defaultValue={person.role || ""} placeholder="Role" onBlur={(e) => { const v = e.target.value.trim(); if (v !== (person.role || "")) updateMutation.mutate({ role: v || undefined }); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") (e.target as HTMLInputElement).value = person.role || ""; }} className="w-48" data-testid="input-edit-role" />
          </ProfileTreeRow>

                              <ProfileTreeRow label={<span data-testid="label-relationship">Relationship</span>} icon={<Heart className="h-3.5 w-3.5" />} hasValue={Boolean(person.relation || (person.professionalRelations || []).length)} showEmpty={showEmptyProfileRows} testId="row-profile-relationship">
            <CombinedRelationshipPicker person={person} onUpdate={(updates) => updateMutation.mutate(updates)} />
          </ProfileTreeRow>

          <ProfileTreeRow label={<span data-testid="label-category">Category</span>} icon={<Shield className="h-3.5 w-3.5" />} hasValue={Boolean(person.cabinetLevel)} showEmpty={showEmptyProfileRows} testId="row-profile-category">
            <Select value={person.cabinetLevel} onValueChange={(v) => updateMutation.mutate({ cabinetLevel: v })}>
              <SelectTrigger className="w-48" data-testid="select-cabinet-level"><SelectValue /></SelectTrigger>
              <SelectContent>{sortedLevels.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
            </Select>
          </ProfileTreeRow>

          <ProfileTreeRow label={<span data-testid="label-familiarity">Familiarity</span>} icon={<Users className="h-3.5 w-3.5" />} hasValue={Boolean(person.familiarity && person.familiarity !== "none")} showEmpty={showEmptyProfileRows || editingFamiliarity} testId="row-profile-familiarity">
            {(person.familiarity && person.familiarity !== "none") || editingFamiliarity ? (
              <Select value={person.familiarity || "none"} onValueChange={(v) => { updateMutation.mutate({ familiarity: v as Person["familiarity"] }); setEditingFamiliarity(false); }}>
                <SelectTrigger className="w-48" data-testid="select-familiarity"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">None</SelectItem><SelectItem value="surface">Surface</SelectItem><SelectItem value="deep">Deep</SelectItem></SelectContent>
              </Select>
            ) : <Button variant="ghost" size="icon" onClick={() => setEditingFamiliarity(true)} data-testid="button-add-familiarity"><Plus className="h-3 w-3" /></Button>}
          </ProfileTreeRow>

          <ProfileTreeRow label={<span data-testid="label-trust">Trust</span>} icon={<Heart className="h-3.5 w-3.5" />} hasValue={Boolean(person.trust && person.trust !== "none")} showEmpty={showEmptyProfileRows || editingTrust} testId="row-profile-trust">
            {(person.trust && person.trust !== "none") || editingTrust ? (
              <Select value={person.trust || "none"} onValueChange={(v) => { updateMutation.mutate({ trust: v as Person["trust"] }); setEditingTrust(false); }}>
                <SelectTrigger className="w-48" data-testid="select-trust"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="ally">Ally</SelectItem><SelectItem value="positive">Positive</SelectItem><SelectItem value="none">None</SelectItem><SelectItem value="negative">Negative</SelectItem><SelectItem value="enemy">Enemy</SelectItem></SelectContent>
              </Select>
            ) : <Button variant="ghost" size="icon" onClick={() => setEditingTrust(true)} data-testid="button-add-trust"><Plus className="h-3 w-3" /></Button>}
          </ProfileTreeRow>

          <ProfileTreeRow label={<span data-testid="label-introduced-by">Intro</span>} icon={<Link2 className="h-3.5 w-3.5" />} hasValue={Boolean(person.introducedBy && introducedByPerson)} showEmpty={showEmptyProfileRows || showIntroducedBySearch} actionContent={person.introducedBy && introducedByPerson ? <Button size="icon" variant="ghost" className="h-5 w-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" onClick={() => updateMutation.mutate({ introducedBy: "" })} data-testid="button-remove-introduced-by"><X className="h-3 w-3" /></Button> : undefined} testId="row-profile-introduced-by">
            <div className="relative flex justify-end">
              {showIntroducedBySearch ? (
                <div>
                  <Input value={introducedBySearch} onChange={(e) => setIntroducedBySearch(e.target.value)} placeholder="Search people..." className="w-48" autoFocus onBlur={() => setTimeout(() => { setShowIntroducedBySearch(false); setIntroducedBySearch(""); }, 200)} onKeyDown={(e) => { if (e.key === "Escape") { setShowIntroducedBySearch(false); setIntroducedBySearch(""); } }} data-testid="input-introduced-by-search" />
                  {filteredPeopleForIntroduction.length > 0 && <div className="absolute right-0 z-50 mt-1 max-h-48 w-48 overflow-y-auto rounded-md border bg-popover shadow-md scrollbar-thin" data-testid="dropdown-introduced-by">{filteredPeopleForIntroduction.map((p) => <button key={p.id} className="w-full px-3 py-1.5 text-left text-xs hover-elevate" onMouseDown={(e) => e.preventDefault()} onClick={() => { updateMutation.mutate({ introducedBy: p.id }); setShowIntroducedBySearch(false); setIntroducedBySearch(""); }} data-testid={`option-introduced-by-${p.id}`}>{p.name}</button>)}</div>}
                </div>
              ) : person.introducedBy && introducedByPerson ? (
                <button type="button" className="flex w-48 items-center justify-end" onClick={() => { setShowIntroducedBySearch(true); setIntroducedBySearch(introducedByPerson.name); }} data-testid="chip-introduced-by"><ReferenceRenderer refValue={{ type: "person", id: person.introducedBy, canonical: `@person:${person.introducedBy}` }} surface="chat-inline" className="max-w-[12rem]" /></button>
              ) : (
                <Button variant="ghost" size="icon" onClick={() => setShowIntroducedBySearch(true)} data-testid="button-add-introduced-by"><Plus className="h-3 w-3" /></Button>
              )}
            </div>
          </ProfileTreeRow>

          <ProfileTreeRow label={<span data-testid="label-instagram">Instagram</span>} icon={<SiInstagram className="h-3.5 w-3.5" />} hasValue={Boolean(person.socialProfiles?.instagram)} showEmpty={showEmptyProfileRows || editingInstagram} testId="row-profile-instagram"><Input key={person.socialProfiles?.instagram || "new-instagram"} defaultValue={person.socialProfiles?.instagram || ""} placeholder="Instagram URL" onBlur={(e) => { const v = e.target.value.trim(); if (v !== (person.socialProfiles?.instagram || "")) handleSaveSocial("instagram", v); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") (e.target as HTMLInputElement).value = person.socialProfiles?.instagram || ""; }} className="w-48" data-testid="input-social-instagram" /></ProfileTreeRow>
          <ProfileTreeRow label={<span data-testid="label-x">X</span>} icon={<SiX className="h-3.5 w-3.5" />} hasValue={Boolean(person.socialProfiles?.x)} showEmpty={showEmptyProfileRows || editingX} testId="row-profile-x"><Input key={person.socialProfiles?.x || "new-x"} defaultValue={person.socialProfiles?.x || ""} placeholder="X URL" onBlur={(e) => { const v = e.target.value.trim(); if (v !== (person.socialProfiles?.x || "")) handleSaveSocial("x", v); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") (e.target as HTMLInputElement).value = person.socialProfiles?.x || ""; }} className="w-48" data-testid="input-social-x" /></ProfileTreeRow>
          <ProfileTreeRow label={<span data-testid="label-linkedin">LinkedIn</span>} icon={<Linkedin className="h-3.5 w-3.5" />} hasValue={Boolean(person.socialProfiles?.linkedin)} showEmpty={showEmptyProfileRows || editingLinkedin} testId="row-profile-linkedin"><Input key={person.socialProfiles?.linkedin || "new-linkedin"} defaultValue={person.socialProfiles?.linkedin || ""} placeholder="LinkedIn URL" onBlur={(e) => { const v = e.target.value.trim(); if (v !== (person.socialProfiles?.linkedin || "")) handleSaveSocial("linkedin", v); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") (e.target as HTMLInputElement).value = person.socialProfiles?.linkedin || ""; }} className="w-48" data-testid="input-social-linkedin" /></ProfileTreeRow>

          {person.contactInfo.map((c, i) => <ProfileTreeRow key={`contact-${i}`} label={c.label || contactTypeLabels[c.type] || c.type} icon={c.type === "email" ? <Mail className="h-3.5 w-3.5" /> : c.type === "phone" ? <Phone className="h-3.5 w-3.5" /> : <ContactRound className="h-3.5 w-3.5" />} hasValue={Boolean(c.value)} showEmpty={showEmptyProfileRows} actionContent={<Button size="icon" variant="ghost" className="h-5 w-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" onClick={() => setPendingContactDeleteIndex(i)} data-testid={`button-remove-contact-${i}`}><X className="h-3 w-3" /></Button>} testId={`row-profile-contact-${i}`}><Input key={`${c.type}-${c.value}`} defaultValue={c.value} placeholder={c.label || contactTypeLabels[c.type] || c.type} onBlur={(e) => { const v = e.target.value.trim(); if (v !== c.value) updateMutation.mutate({ contactInfo: person.contactInfo.map((item, idx) => idx === i ? { ...item, value: v } : item).filter(item => item.value.trim()) }); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") (e.target as HTMLInputElement).value = c.value; }} data-testid={`input-contact-${i}`} /></ProfileTreeRow>)}

          {showAddContact ? <ProfileTreeRow label="New contact" icon={<Plus className="h-3.5 w-3.5" />} hasValue={true} showEmpty={true} testId="row-profile-new-contact"><div className="flex flex-wrap items-center justify-end gap-1.5"><Select value={newContactType} onValueChange={(v) => setNewContactType(v as any)}><SelectTrigger className="w-48" data-testid="select-contact-type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="email">Email</SelectItem><SelectItem value="phone">Phone</SelectItem><SelectItem value="social">Social</SelectItem><SelectItem value="other">Other</SelectItem></SelectContent></Select><Input value={newContactLabel} onChange={(e) => setNewContactLabel(e.target.value)} placeholder="Label" className="h-8 w-20 text-right" data-testid="input-contact-label" /><Input value={newContactValue} onChange={(e) => setNewContactValue(e.target.value)} placeholder="Value" className="h-8 min-w-[120px] flex-1 text-right" data-testid="input-contact-value" /><Button size="sm" onClick={() => { if (newContactValue.trim()) { updateMutation.mutate({ contactInfo: [...person.contactInfo, { type: newContactType, label: newContactLabel || contactTypeLabels[newContactType], value: newContactValue }] }); setShowAddContact(false); setNewContactLabel(""); setNewContactValue(""); } }} data-testid="button-save-contact">Add</Button><Button variant="ghost" size="icon" onClick={() => setShowAddContact(false)}><X className="h-3 w-3" /></Button></div></ProfileTreeRow> : <div className="px-2 py-1"><Button variant="ghost" size="sm" onClick={() => setShowAddContact(true)} data-testid="button-add-contact"><Plus className="mr-1 h-3 w-3" />Contact info</Button></div>}
        </div>

      </ProfileDetailSection>

      <InteractionsTab person={person} onUpdate={handleRefetch} showAdd={showNewLog} setShowAdd={setShowNewLog} />

      </div>

      <AlertDialog open={pendingContactDeleteIndex !== null} onOpenChange={(open) => !open && setPendingContactDeleteIndex(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete contact info?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove “{pendingContactDeleteIndex !== null ? person.contactInfo[pendingContactDeleteIndex]?.value : ""}” from {person.name}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingContactDeleteIndex === null) return;
                updateMutation.mutate({ contactInfo: person.contactInfo.filter((_, idx) => idx !== pendingContactDeleteIndex) });
                setPendingContactDeleteIndex(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteConfirm} onOpenChange={(open) => { setDeleteConfirm(open); if (!open) setDeleteConfirmText(""); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {person.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove {person.name} and all their data. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-6 pb-2">
            <label className="text-xs text-muted-foreground mb-1.5 block">
              Type <span className="font-semibold text-foreground">Confirm Delete</span> to proceed
            </label>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="Confirm Delete"
              data-testid="input-confirm-delete"
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-person">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteConfirmText !== "Confirm Delete"}
              data-testid="button-confirm-delete-person"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface GmailInteraction {
  date: string;
  subject: string;
  direction: 'sent' | 'received';
  snippet?: string;
}

interface GmailContact {
  email: string;
  name: string;
  sentCount: number;
  receivedCount: number;
  threadCount: number;
  lastInteraction: string;
  firstInteraction: string;
  sampleSubjects: string[];
  interactions: GmailInteraction[];
}

interface GmailStatus {
  connected: boolean;
  readAccess: boolean;
  connectorAccess: boolean;
  email: string | null;
  oauthConfigured: boolean;
}

interface ImportQueueStatus {
  total: number;
  pending: number;
  added: number;
  merged: number;
  skipped: number;
  scan: {
    status: "idle" | "scanning" | "done" | "error";
    mode?: string;
    nextPageToken?: string;
    threadsProcessed: number;
    estimatedTotal: number;
    contactsFound: number;
    batchNumber?: number;
    oldestDate?: string;
    newestDate?: string;
    lastCompletedAt?: string;
    error?: string;
  };
  stats: { totalAdded: number; totalMerged: number; totalSkipped: number };
}

interface ImportContactInfo {
  type: "email" | "phone" | "social" | "other";
  label: string;
  value: string;
}

interface ImportCandidate extends GmailContact {
  decision: string;
  scannedAt: string;
  accountId?: string;
  source?: string;
  sourceId?: string;
  displayName?: string;
  givenName?: string;
  familyName?: string;
  company?: string;
  role?: string;
  emails?: string[];
  phones?: string[];
  contactInfo?: ImportContactInfo[];
  department?: string;
  addresses?: Array<Record<string, unknown>>;
  urls?: Array<Record<string, unknown>>;
  dates?: Array<Record<string, unknown>>;
  birthday?: Record<string, unknown>;
}

function textValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function formatImportedDate(record: Record<string, unknown>): string | null {
  const year = typeof record.year === "number" ? record.year : null;
  const month = typeof record.month === "number" ? record.month : null;
  const day = typeof record.day === "number" ? record.day : null;
  if (!month || !day) return null;
  const parsed = new Date(Date.UTC(year || 2000, month - 1, day));
  const formatted = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" as const } : {}),
    timeZone: "UTC",
  }).format(parsed);
  return year ? formatted : formatted.replace(/,? 2000$/, "");
}

function formatImportedAddress(address: Record<string, unknown>): string | null {
  const parts = [
    textValue(address, "street"),
    textValue(address, "city"),
    [textValue(address, "region"), textValue(address, "postalCode")].filter(Boolean).join(" "),
    textValue(address, "country"),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function ExpandableInteractions({ interactions }: { interactions: GmailInteraction[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const sorted = [...(interactions || [])]
    .sort((a, b) => parseDateString(b.date).getTime() - parseDateString(a.date).getTime())
    .slice(0, 15);

  return (
    <div className="max-h-52 overflow-y-auto scrollbar-thin space-y-0.5 pl-2 border-l border-muted ml-1">
      {sorted.map((ix, i) => {
        const isOpen = expandedIdx === i;
        return (
          <div key={i} className="py-0.5">
            <button
              type="button"
              className="w-full text-left flex items-start gap-2 text-xs hover-elevate rounded px-1 py-0.5"
              onClick={() => setExpandedIdx(isOpen ? null : i)}
              data-testid={`interaction-row-${i}`}
            >
              <span className={`shrink-0 mt-0.5 ${ix.direction === "sent" ? "text-primary" : "text-muted-foreground"}`}>
                {ix.direction === "sent" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{ix.subject}</span>
                  <span className="text-muted-foreground shrink-0">{formatShortDate(ix.date)}</span>
                </div>
              </div>
              <span className="shrink-0 mt-0.5 text-muted-foreground">
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </span>
            </button>
            {isOpen && ix.snippet && (
              <div className="ml-6 mr-1 mt-1 mb-1.5 text-xs text-muted-foreground leading-relaxed bg-muted/30 rounded p-2">
                {ix.snippet}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ImportCandidateDetail({
  candidate,
  levels,
  existingPeople,
  onDecide,
  isPending,
}: {
  candidate: ImportCandidate;
  levels: CabinetLevel[];
  existingPeople: PersonIndex[];
  onDecide: (params: { email: string; decision: "add" | "merge" | "skip"; cabinetLevel?: string; tags?: string[]; mergePersonId?: string; name?: string; company?: string; role?: string; relation?: string; professionalRelations?: string[]; familiarity?: string; trust?: string; met?: string; notes?: string; introducedBy?: string }) => void;
  isPending: boolean;
}) {
  const [cabinet, setCabinet] = useState("network");
  const [tags, setTags] = useState<string[]>([]);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  const [mergeQuery, setMergeQuery] = useState("");
  const [showMerge, setShowMerge] = useState(false);
  const [editName, setEditName] = useState(candidate.name || candidate.email.split("@")[0]);
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [personalRelation, setPersonalRelation] = useState("");
  const [profRelations, setProfRelations] = useState<string[]>([]);
  const [relationSearch, setRelationSearch] = useState("");
  const [familiarity, setFamiliarity] = useState("none");
  const [trust, setTrust] = useState("none");
  const [editingImportCompany, setEditingImportCompany] = useState(false);
  const [editingImportRole, setEditingImportRole] = useState(false);
  const [editingImportFamiliarity, setEditingImportFamiliarity] = useState(false);
  const [editingImportTrust, setEditingImportTrust] = useState(false);
  const [showImportRelationSearch, setShowImportRelationSearch] = useState(false);
  const [met, setMet] = useState("");
  const [notes, setNotes] = useState("");
  const [introducedBy, setIntroducedBy] = useState("");
  const [introducedBySearch, setIntroducedBySearch] = useState("");
  const [showIntroducedByPicker, setShowIntroducedByPicker] = useState(false);

  useEffect(() => {
    setEditName(candidate.name || candidate.email.split("@")[0]);
    setCabinet("network");
    setTags([]);
    setMergeTarget(null);
    setMergeQuery("");
    setShowMerge(false);
    setRole(candidate.role || "");
    setPersonalRelation("");
    setProfRelations([]);
    setRelationSearch("");
    setFamiliarity("none");
    setTrust("none");
    setEditingImportCompany(false);
    setEditingImportRole(false);
    setEditingImportFamiliarity(false);
    setEditingImportTrust(false);
    setShowImportRelationSearch(false);
    setNotes("");
    setIntroducedBy("");
    setIntroducedBySearch("");
    setShowIntroducedByPicker(false);

    if (candidate.company) {
      setCompany(candidate.company);
    } else {
      const FREE_DOMAINS = new Set(["gmail.com","googlemail.com","yahoo.com","yahoo.co.uk","hotmail.com","outlook.com","live.com","msn.com","aol.com","icloud.com","me.com","mac.com","mail.com","protonmail.com","proton.me","zoho.com","yandex.com","gmx.com","gmx.net","fastmail.com","hey.com","tutanota.com","pm.me","comcast.net","verizon.net","att.net","sbcglobal.net","cox.net","charter.net","earthlink.net","optonline.net","frontier.com","roadrunner.com"]);
      const domain = candidate.email.split("@")[1]?.toLowerCase() || "";
      if (domain && domain !== "contacts.local" && !FREE_DOMAINS.has(domain)) {
        const parts = domain.split(".");
        const name = parts[0];
        const KNOWN_COMPANIES: Record<string, string> = { ibm: "IBM", hp: "HP", att: "AT&T", bmw: "BMW", pwc: "PwC", ey: "EY", kpmg: "KPMG", hbo: "HBO", bbc: "BBC", cnn: "CNN", mit: "MIT", nasa: "NASA", nyu: "NYU", ucla: "UCLA", usc: "USC", jpmorgan: "JPMorgan", mckinsey: "McKinsey" };
        const companyName = KNOWN_COMPANIES[name] || name.charAt(0).toUpperCase() + name.slice(1);
        setCompany(companyName);
      } else {
        setCompany("");
      }
    }

    if (candidate.firstInteraction) {
      setMet(candidate.firstInteraction.split("T")[0]);
    } else {
      setMet("");
    }
  }, [candidate.email, candidate.company, candidate.role]);

  const mergeResults = useMemo(() => {
    if (!mergeQuery) return [];
    return fuzzyMatchPeople(mergeQuery, existingPeople, 8);
  }, [mergeQuery, existingPeople]);

  const mergedPersonName = mergeTarget ? existingPeople.find(p => p.id === mergeTarget)?.name : null;

  const suggestedMerge = useMemo(() => {
    const name = candidate.name || "";
    if (!name || name.length < 2) return null;
    const matches = fuzzyMatchPeople(name, existingPeople, 1);
    return matches.length > 0 ? matches[0] : null;
  }, [candidate.name, existingPeople]);

  const sorted = useMemo(() =>
    [...(candidate.interactions || [])].sort((a, b) => parseDateString(b.date).getTime() - parseDateString(a.date).getTime()),
    [candidate.interactions]
  );

  const filteredRelationOptions = RELATION_OPTIONS.filter(r =>
    r.toLowerCase().includes(relationSearch.toLowerCase())
  );

  const introducedByName = introducedBy ? existingPeople.find(p => p.id === introducedBy)?.name : null;
  const importedAddresses = (candidate.addresses || [])
    .map(formatImportedAddress)
    .filter((value): value is string => Boolean(value));
  const importedDates = (candidate.dates || []).flatMap((date) => {
    const value = formatImportedDate(date);
    if (!value) return [];
    return [{ label: textValue(date, "label") || "Date", value }];
  });
  const importedBirthday = candidate.birthday ? formatImportedDate(candidate.birthday) : null;

  const filteredIntroducedByPeople = useMemo(() => {
    if (!introducedBySearch) return [];
    return existingPeople
      .filter(p => p.name.toLowerCase().includes(introducedBySearch.toLowerCase()))
      .slice(0, 8);
  }, [existingPeople, introducedBySearch]);

  return (
    <div className="h-full flex flex-col" data-testid="import-detail">
      <div className="p-3 border-b space-y-2">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onDecide({ email: candidate.email, decision: "skip" })}
            disabled={isPending}
            data-testid="button-skip-contact"
          >
            Skip
          </Button>
          <div className="flex-1" />
          {!mergeTarget && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setShowMerge(!showMerge); setMergeQuery(""); }}
              disabled={isPending}
              data-testid="button-toggle-merge"
            >
              <Users className="h-3 w-3 mr-1" />
              {showMerge ? "Cancel" : "Merge"}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => {
              if (mergeTarget) {
                onDecide({ email: candidate.email, decision: "merge", mergePersonId: mergeTarget, tags, name: editName, notes: notes || undefined, introducedBy: introducedBy || undefined });
              } else {
                onDecide({
                  email: candidate.email,
                  decision: "add",
                  cabinetLevel: cabinet,
                  tags,
                  name: editName,
                  company: company || undefined,
                  role: role || undefined,
                  relation: personalRelation || undefined,
                  professionalRelations: profRelations.length > 0 ? profRelations : undefined,
                  familiarity,
                  trust,
                  met: met || undefined,
                  notes: notes || undefined,
                  introducedBy: introducedBy || undefined,
                });
              }
            }}
            disabled={isPending}
            data-testid="button-add-contact"
          >
            {isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            {mergeTarget ? "Merge" : "Add"}
          </Button>
        </div>

        {!mergeTarget && suggestedMerge && (
          <button
            type="button"
            className="w-full text-left p-2 rounded-md border border-dashed text-xs flex items-center justify-between gap-2 hover-elevate"
            onClick={() => { setMergeTarget(suggestedMerge.id); setShowMerge(false); }}
            data-testid="button-suggested-merge"
          >
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Users className="h-3 w-3" />
              Merge with <span className="font-medium text-foreground">{suggestedMerge.name}</span>?
            </span>
            <span className="inline-flex items-center bg-cat-growth/15 text-cat-growth-foreground border border-cat-growth/30 rounded-sm text-xs font-medium px-2 py-0.5">{suggestedMerge.cabinetLevel}</span>
          </button>
        )}

        {showMerge && (
          <div className="space-y-2">
            <Input
              placeholder="Search existing contacts..."
              value={mergeQuery}
              onChange={e => setMergeQuery(e.target.value)}
              className="text-xs"
              autoFocus
              data-testid="input-merge-search"
            />
            {mergeResults.length > 0 && (
              <div className="border rounded-md divide-y max-h-36 overflow-y-auto">
                {mergeResults.map(p => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-2 p-2 cursor-pointer hover-elevate text-xs"
                    onClick={() => { setMergeTarget(p.id); setShowMerge(false); }}
                    data-testid={`merge-option-${p.id}`}
                  >
                    <span>{p.name}</span>
                    <span className="inline-flex items-center bg-cat-growth/15 text-cat-growth-foreground border border-cat-growth/30 rounded-sm text-xs font-medium px-2 py-0.5">{p.cabinetLevel}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="p-4 border-b space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              className="text-base font-medium border-none px-0 h-auto focus-visible:ring-0"
              data-testid="input-candidate-name"
            />
            <div className="text-xs text-muted-foreground mt-0.5 space-y-0.5" data-testid="text-candidate-contact-info">
              {(candidate.emails?.length ? candidate.emails : candidate.email.endsWith("@contacts.local") ? [] : [candidate.email]).map((email) => (
                <p key={email}>{email}</p>
              ))}
              {candidate.phones?.map((phone) => (
                <p key={phone}>{phone}</p>
              ))}
              {candidate.source === "ios_contacts" && <p className="text-cat-channel-foreground">iOS Contacts</p>}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 text-xs text-muted-foreground">
            <Badge variant="outline" className="text-xs">{candidate.source === "ios_contacts" ? "contact" : `${candidate.threadCount} threads`}</Badge>
          </div>
        </div>
        {candidate.source !== "ios_contacts" && (
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span>{candidate.sentCount} sent</span>
            <span>{candidate.receivedCount} received</span>
            {candidate.lastInteraction && <span>Last: {daysAgo(candidate.lastInteraction)}</span>}
            {candidate.firstInteraction && <span>First: {daysAgo(candidate.firstInteraction)}</span>}
          </div>
        )}
        {candidate.source === "ios_contacts" && (candidate.company || candidate.role || candidate.department || importedBirthday || importedAddresses.length > 0 || importedDates.length > 0) && (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {(candidate.company || candidate.role || candidate.department) && (
              <>
                <span className="text-muted-foreground">Work</span>
                <span>{[candidate.role, candidate.company, candidate.department].filter(Boolean).join(" · ")}</span>
              </>
            )}
            {importedBirthday && (
              <>
                <span className="text-muted-foreground">Birthday</span>
                <span>{importedBirthday}</span>
              </>
            )}
            {importedAddresses.map((address, index) => (
              <Fragment key={`${address}-${index}`}>
                <span className="text-muted-foreground">Address</span>
                <span>{address}</span>
              </Fragment>
            ))}
            {importedDates.map((date, index) => (
              <Fragment key={`${date.label}-${date.value}-${index}`}>
                <span className="text-muted-foreground">{date.label}</span>
                <span>{date.value}</span>
              </Fragment>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="p-4 space-y-4">
          {mergeTarget ? (
            <div className="border rounded-md p-3 bg-accent/30 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Merge into: {mergedPersonName}
                </p>
                <Button variant="ghost" size="icon" onClick={() => setMergeTarget(null)} data-testid="button-clear-merge">
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 items-center text-sm">
                <span className="text-xs text-muted-foreground text-right">Category</span>
                <Select value={cabinet} onValueChange={setCabinet}>
                  <SelectTrigger className="w-48" data-testid="select-import-cabinet">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {levels.map(l => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select>

                <span className="text-xs text-muted-foreground text-right">Familiarity</span>
                <div>
                  {familiarity !== "none" ? (
                    <Select value={familiarity} onValueChange={setFamiliarity}>
                      <SelectTrigger className="w-48" data-testid="select-import-familiarity">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="surface">Surface</SelectItem>
                        <SelectItem value="deep">Deep</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : editingImportFamiliarity ? (
                    <Select value={familiarity} onValueChange={(v) => { setFamiliarity(v); setEditingImportFamiliarity(false); }}>
                      <SelectTrigger className="w-48" data-testid="select-import-familiarity" autoFocus>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="surface">Surface</SelectItem>
                        <SelectItem value="deep">Deep</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Button variant="ghost" size="icon" onClick={() => setEditingImportFamiliarity(true)} data-testid="button-add-import-familiarity">
                      <Plus className="h-3 w-3" />
                    </Button>
                  )}
                </div>

                <span className="text-xs text-muted-foreground text-right">Trust</span>
                <div>
                  {trust !== "none" ? (
                    <Select value={trust} onValueChange={setTrust}>
                      <SelectTrigger className="w-48" data-testid="select-import-trust">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ally">Ally</SelectItem>
                        <SelectItem value="positive">Positive</SelectItem>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="negative">Negative</SelectItem>
                        <SelectItem value="enemy">Enemy</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : editingImportTrust ? (
                    <Select value={trust} onValueChange={(v) => { setTrust(v); setEditingImportTrust(false); }}>
                      <SelectTrigger className="w-48" data-testid="select-import-trust" autoFocus>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ally">Ally</SelectItem>
                        <SelectItem value="positive">Positive</SelectItem>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="negative">Negative</SelectItem>
                        <SelectItem value="enemy">Enemy</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Button variant="ghost" size="icon" onClick={() => setEditingImportTrust(true)} data-testid="button-add-import-trust">
                      <Plus className="h-3 w-3" />
                    </Button>
                  )}
                </div>

                <span className="text-xs text-muted-foreground text-right">Tags</span>
                <ImportTagPicker tags={tags} onChange={setTags} />

                <span className="text-xs text-muted-foreground text-right">Met</span>
                <div>
                  {met ? (
                    <Input type="date" value={met} onChange={e => setMet(e.target.value)} className="w-48" data-testid="input-import-met" />
                  ) : (
                    <span className="text-xs text-muted-foreground">Unknown</span>
                  )}
                </div>

                <span className="text-xs text-muted-foreground text-right">Company</span>
                <div>
                  {company ? (
                    <Input value={company} onChange={e => setCompany(e.target.value)} data-testid="input-import-company" className="w-44 border-0 bg-transparent px-1 py-0.5 -ml-1 text-sm focus-visible:ring-1 focus-visible:ring-ring" />
                  ) : editingImportCompany ? (
                    <Input autoFocus value={company} onChange={e => setCompany(e.target.value)} placeholder="Company name" className="w-48" onKeyDown={(e) => { if (e.key === "Escape") setEditingImportCompany(false); }} onBlur={() => { if (!company) setEditingImportCompany(false); }} data-testid="input-import-company" />
                  ) : (
                    <Button variant="ghost" size="icon" onClick={() => setEditingImportCompany(true)} data-testid="button-add-import-company">
                      <Plus className="h-3 w-3" />
                    </Button>
                  )}
                </div>

                <span className="text-xs text-muted-foreground text-right">Role</span>
                <div>
                  {role ? (
                    <Input value={role} onChange={e => setRole(e.target.value)} data-testid="input-import-role" className="w-44 border-0 bg-transparent px-1 py-0.5 -ml-1 text-sm focus-visible:ring-1 focus-visible:ring-ring" />
                  ) : editingImportRole ? (
                    <Input autoFocus value={role} onChange={e => setRole(e.target.value)} placeholder="Role" className="w-48" onKeyDown={(e) => { if (e.key === "Escape") setEditingImportRole(false); }} onBlur={() => { if (!role) setEditingImportRole(false); }} data-testid="input-import-role" />
                  ) : (
                    <Button variant="ghost" size="icon" onClick={() => setEditingImportRole(true)} data-testid="button-add-import-role">
                      <Plus className="h-3 w-3" />
                    </Button>
                  )}
                </div>

                <span className="text-xs text-muted-foreground text-right">Prof. Relation</span>
                <div className="flex flex-wrap gap-1 items-center">
                  {profRelations.map(pr => (
                    <span key={pr} className="inline-flex items-center bg-cat-channel/15 text-cat-channel-foreground border border-cat-channel/30 rounded-sm text-xs font-medium px-2 py-0.5" data-testid={`badge-import-prof-${pr.toLowerCase()}`}>
                      {pr}
                      <button className="ml-1" onClick={() => setProfRelations(prev => prev.filter(r => r !== pr))} data-testid={`button-remove-import-prof-${pr.toLowerCase()}`}>
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" data-testid="button-add-import-prof-relation">
                        <Plus className="h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {PROFESSIONAL_RELATION_OPTIONS.filter(o => !profRelations.includes(o)).map(opt => (
                        <DropdownMenuItem key={opt} onClick={() => setProfRelations(prev => [...prev, opt])} data-testid={`menu-import-prof-${opt.toLowerCase()}`}>
                          {opt}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <span className="text-xs text-muted-foreground text-right">Personal Relation</span>
                <div className="relative">
                  {personalRelation ? (
                    <div className="flex items-center gap-1">
                      <span className="inline-flex items-center bg-cat-channel/15 text-cat-channel-foreground border border-cat-channel/30 rounded-sm text-xs font-medium px-2 py-0.5" data-testid="badge-import-relation">
                        {personalRelation}
                        <button className="ml-1" onClick={() => setPersonalRelation("")} data-testid="button-remove-import-relation">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    </div>
                  ) : showImportRelationSearch ? (
                    <div>
                      <Input
                        value={relationSearch}
                        onChange={e => setRelationSearch(e.target.value)}
                        placeholder="Search relations..."
                        className="w-48"
                        autoFocus
                        onBlur={() => setTimeout(() => { setShowImportRelationSearch(false); setRelationSearch(""); }, 200)}
                        onKeyDown={(e) => { if (e.key === "Escape") { setShowImportRelationSearch(false); setRelationSearch(""); } }}
                        data-testid="input-import-relation-search"
                      />
                      {filteredRelationOptions.length > 0 && (
                        <div className="absolute z-50 mt-1 w-48 bg-popover border rounded-md shadow-md max-h-48 overflow-y-auto" data-testid="dropdown-import-relation">
                          {filteredRelationOptions.map(r => (
                            <button
                              key={r}
                              className="w-full text-left px-3 py-1.5 text-sm hover-elevate"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => { setPersonalRelation(r); setRelationSearch(""); setShowImportRelationSearch(false); }}
                              data-testid={`option-import-relation-${r.toLowerCase().replace(/\s+/g, '-')}`}
                            >
                              {r}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <Button variant="ghost" size="icon" onClick={() => setShowImportRelationSearch(true)} data-testid="button-add-import-relation">
                      <Plus className="h-3 w-3" />
                    </Button>
                  )}
                </div>

                <span className="text-xs text-muted-foreground text-right">Introduced By</span>
                <div className="relative">
                  {introducedBy && introducedByName ? (
                    <div className="flex items-center gap-1">
                      <span className="inline-flex items-center bg-cat-channel/15 text-cat-channel-foreground border border-cat-channel/30 rounded-sm text-xs font-medium px-2 py-0.5" data-testid="badge-import-introduced-by">
                        {introducedByName}
                        <button
                          className="ml-1 inline-flex"
                          onClick={(e) => { e.stopPropagation(); setIntroducedBy(""); }}
                          data-testid="button-remove-import-introduced-by"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    </div>
                  ) : (
                    <div>
                      <Input
                        value={introducedBySearch}
                        onChange={(e) => setIntroducedBySearch(e.target.value)}
                        onFocus={() => setShowIntroducedByPicker(true)}
                        onBlur={() => setTimeout(() => setShowIntroducedByPicker(false), 200)}
                        placeholder="Search people..."
                        className="w-44 text-sm"
                        data-testid="input-import-introduced-by"
                      />
                      {showIntroducedByPicker && filteredIntroducedByPeople.length > 0 && (
                        <div className="absolute z-10 top-full mt-1 w-48 border rounded-md bg-popover shadow-md max-h-36 overflow-y-auto">
                          {filteredIntroducedByPeople.map(p => (
                            <div
                              key={p.id}
                              className="flex items-center justify-between gap-2 p-2 cursor-pointer hover:bg-accent text-xs"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                setIntroducedBy(p.id);
                                setIntroducedBySearch("");
                                setShowIntroducedByPicker(false);
                              }}
                              data-testid={`introduced-by-option-${p.id}`}
                            >
                              <span>{p.name}</span>
                              <span className="inline-flex items-center bg-cat-growth/15 text-cat-growth-foreground border border-cat-growth/30 rounded-sm text-xs font-medium px-2 py-0.5">{p.cabinetLevel}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">Notes</span>
                <Textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Add notes about this person..."
                  className="min-h-[60px] resize-none text-sm"
                  data-testid="textarea-import-notes"
                />
              </div>
            </div>
          )}

          {sorted.length > 0 && (
            <div className="space-y-1 pt-2">
              <h4 className="text-xs font-medium text-muted-foreground mb-2">Email History ({sorted.length})</h4>
              <ExpandableInteractions interactions={candidate.interactions} />
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

const PAGE_SIZE = 50;

function ImportView({ onSelectPerson, selectedEmailOverride, onClearSelection }: { onSelectPerson: (id: string) => void; selectedEmailOverride?: string | null; onClearSelection?: () => void }) {
  const { toast } = useToast();
  const [selectedEmail, setSelectedEmailRaw] = useState<string | null>(selectedEmailOverride ?? null);
  const setSelectedEmail = useCallback((email: string | null) => {
    setSelectedEmailRaw(email);
    if (email === null) onClearSelection?.();
  }, [onClearSelection]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [showSkipListManager, setShowSkipListManager] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (selectedEmailOverride !== undefined) setSelectedEmailRaw(selectedEmailOverride);
  }, [selectedEmailOverride]);

  const { data: gmailStatus, isLoading: statusLoading } = useQuery<GmailStatus>({
    queryKey: ["/api/gmail/status"],
  });

  const { data: accountsData } = useQuery<{ accounts: Array<{ id: string; email: string; label: string }> }>({
    queryKey: ["/api/gmail/accounts"],
  });

  const { data: queueStatus, refetch: refetchStatus } = useQuery<ImportQueueStatus>({
    queryKey: ["/api/import-queue/status"],
    refetchInterval: (query) => {
      const data = query.state.data as ImportQueueStatus | undefined;
      return data?.scan?.status === "scanning" ? 2000 : false;
    },
  });

  const { data: candidatesData, refetch: refetchCandidates } = useQuery<{ candidates: ImportCandidate[] }>({
    queryKey: ["/api/import-queue/candidates"],
    enabled: !!queueStatus && queueStatus.pending > 0,
  });

  const { data: cabinetData } = useQuery<CabinetConfig>({
    queryKey: ["/api/people/cabinet-config"],
  });

  const { data: existingPeople } = useQuery<{ people: PersonIndex[] }>({
    queryKey: ["/api/people"],
  });

  const { data: skipListData, refetch: refetchSkipList } = useQuery<{ skipList: { email: string; name?: string; skippedAt: string }[] }>({
    queryKey: ["/api/gmail/contacts/skip-list"],
  });

  useEffect(() => {
    if (!selectedAccountId && accountsData?.accounts?.length) {
      setSelectedAccountId(accountsData.accounts[0].id);
    }
  }, [accountsData, selectedAccountId]);

  const scanMutation = useMutation({
    mutationFn: async (mode: "start" | "continue" | "refresh") => {
      const res = await apiRequest("POST", "/api/import-queue/scan", {
        mode,
        accountId: selectedAccountId || undefined,
      });
      return res.json();
    },
    onSuccess: (_data, mode) => {
      refetchStatus();
      toast({ title: mode === "start" ? "Import started" : mode === "continue" ? "Resuming import" : "Refreshing contacts" });
    },
    onError: (err: Error) => {
      toast({ title: "Scan failed", description: err.message, variant: "destructive" });
    },
  });

  const cancelScan = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/import-queue/cancel");
      return res.json();
    },
    onSuccess: () => {
      refetchStatus();
      toast({ title: "Scan cancelled" });
    },
    onError: (err: Error) => {
      toast({ title: "Cancel failed", description: err.message, variant: "destructive" });
    },
  });

  const decideMutation = useMutation({
    mutationFn: async (params: { email: string; decision: "add" | "merge" | "skip"; cabinetLevel?: string; tags?: string[]; mergePersonId?: string; name?: string; company?: string; role?: string; relation?: string; professionalRelations?: string[]; familiarity?: string; trust?: string; met?: string; notes?: string; introducedBy?: string }) => {
      const res = await apiRequest("POST", "/api/import-queue/decide", params);
      return res.json();
    },
    onSuccess: (_data, vars) => {
      const currentIdx = paginated.findIndex(c => c.email === vars.email);
      const nextCandidate = currentIdx >= 0 ? paginated[currentIdx + 1] || paginated[currentIdx - 1] : null;

      refetchCandidates();
      refetchStatus();
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      queryClient.invalidateQueries({ queryKey: ["/api/people/email-map"] });

      if (vars.decision === "add" || vars.decision === "merge") {
        const personId = _data?.person?.id || vars.mergePersonId;
        if (personId) {
          onSelectPerson(personId);
          return;
        }
      }
      setSelectedEmail(nextCandidate?.email ?? null);

      const action = vars.decision === "add" ? "Added" : vars.decision === "merge" ? "Merged" : "Skipped";
      toast({ title: `${action} ${vars.name || vars.email}` });
    },
    onError: (err: Error) => {
      toast({ title: "Action failed", description: err.message, variant: "destructive" });
    },
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/import-queue/reset", {});
      return res.json();
    },
    onSuccess: () => {
      refetchStatus();
      refetchCandidates();
      setSelectedEmail(null);
      toast({ title: "Import queue cleared" });
    },
  });

  const startOAuth = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/gmail/oauth/start");
      if (!res.ok) throw new Error("Failed to start OAuth");
      const data = await res.json();
      window.open(data.url, "_blank", "width=500,height=700");
    },
  });

  const allCandidates = candidatesData?.candidates || [];
  const levels = cabinetData?.levels ? [...cabinetData.levels].sort((a, b) => a.order - b.order) : [];
  const scan = queueStatus?.scan;
  const isScanning = scan?.status === "scanning";
  const hasCompleted = !!scan?.lastCompletedAt;
  const canContinue = !!scan?.nextPageToken && scan?.status !== "scanning";

  const filtered = useMemo(() => {
    if (!searchQuery) return allCandidates;
    const q = searchQuery.toLowerCase();
    return allCandidates.filter(c =>
      (c.name || "").toLowerCase().includes(q) || c.email.toLowerCase().includes(q)
    );
  }, [allCandidates, searchQuery]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [filtered, page]);

  useEffect(() => { setPage(0); }, [searchQuery]);

  const selectedCandidate = useMemo(() =>
    selectedEmail ? allCandidates.find(c => c.email === selectedEmail) : null,
    [selectedEmail, allCandidates]
  );

  if (statusLoading) {
    return (
      <div className="space-y-3" data-testid="import-loading">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!gmailStatus?.readAccess) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="import-no-access">
        <Card className="max-w-sm w-full">
          <CardContent className="pt-6">
            <div className="text-center space-y-4">
              <Mail className="h-10 w-10 text-muted-foreground/30 mx-auto" />
              <div>
                <h3 className="font-medium text-sm">Connect Gmail for Import</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  {gmailStatus?.oauthConfigured
                    ? "Authorize full inbox access to scan for contacts."
                    : "Google OAuth credentials needed. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Settings."}
                </p>
              </div>
              {gmailStatus?.oauthConfigured && (
                <Button
                  onClick={() => startOAuth.mutate()}
                  disabled={startOAuth.isPending}
                  data-testid="button-authorize-gmail"
                >
                  {startOAuth.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Mail className="h-4 w-4 mr-2" />}
                  Authorize Gmail
                </Button>
              )}
              {gmailStatus?.connectorAccess && (
                <p className="text-xs text-muted-foreground">
                  Connector connected (send/labels only). Full read access requires OAuth.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const scanControls = (
    <div className="space-y-3 p-3 border-b">
      <div className="flex items-center gap-2 flex-wrap">
        <Mail className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Gmail Import</span>
        {queueStatus && queueStatus.pending > 0 && (
          <Badge variant="secondary" className="text-xs font-mono px-1 py-0" data-testid="badge-pending-count">
            {queueStatus.pending} pending
          </Badge>
        )}
      </div>

      {(accountsData?.accounts?.length ?? 0) > 1 && !isScanning && (
        <Select
          value={selectedAccountId || accountsData!.accounts[0]?.id || ""}
          onValueChange={setSelectedAccountId}
        >
          <SelectTrigger className="text-xs" data-testid="select-gmail-account">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {accountsData!.accounts.map(a => (
              <SelectItem key={a.id} value={a.id}>{a.label} ({a.email})</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {isScanning && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
            <span className="text-xs">
              {scan.estimatedTotal > 0
                ? `Batch ${scan.batchNumber || 1} — ${scan.threadsProcessed.toLocaleString()} / ~${scan.estimatedTotal.toLocaleString()}`
                : `Scanning batch ${scan.batchNumber || 1}...`}
            </span>
          </div>
          <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
            {scan.estimatedTotal > 0 ? (
              <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${Math.max(Math.round((scan.threadsProcessed / scan.estimatedTotal) * 100), 2)}%` }} />
            ) : (
              <div className="h-full bg-primary/60 rounded-full animate-pulse" style={{ width: '30%' }} />
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {scan.contactsFound > 0 ? `${scan.contactsFound} found` : "Searching..."}
            </span>
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => cancelScan.mutate()} disabled={cancelScan.isPending} data-testid="button-cancel-scan">
              <X className="h-3 w-3 mr-0.5" /> Cancel
            </Button>
          </div>
        </div>
      )}

      {scan?.status === "error" && (
        <div className="text-xs text-destructive bg-destructive/10 rounded-md p-2" data-testid="scan-error">
          {scan.error || "Scan encountered an error"}
        </div>
      )}

      {!isScanning && (
        <div className="flex gap-1.5 flex-wrap">
          {!hasCompleted && !canContinue && (
            <Button size="sm" onClick={() => scanMutation.mutate("start")} disabled={scanMutation.isPending} data-testid="button-start-import">
              {scanMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Search className="h-3 w-3 mr-1" />}
              Start Import
            </Button>
          )}
          {canContinue && (
            <Button size="sm" onClick={() => scanMutation.mutate("continue")} disabled={scanMutation.isPending} data-testid="button-continue-import">
              {scanMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Play className="h-3 w-3 mr-1" />}
              Continue
            </Button>
          )}
          {hasCompleted && (
            <Button variant="outline" size="sm" onClick={() => scanMutation.mutate("refresh")} disabled={scanMutation.isPending} data-testid="button-refresh-import">
              {scanMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
              Refresh
            </Button>
          )}
          {(hasCompleted || canContinue || (queueStatus && queueStatus.total > 0)) && (
            <Button variant="ghost" size="sm" onClick={() => scanMutation.mutate("start")} disabled={scanMutation.isPending} data-testid="button-start-fresh">
              Start Fresh
            </Button>
          )}
        </div>
      )}

      {queueStatus && (queueStatus.stats.totalAdded > 0 || queueStatus.stats.totalMerged > 0 || queueStatus.stats.totalSkipped > 0) && (
        <div className="flex gap-1.5 flex-wrap">
          {queueStatus.stats.totalAdded > 0 && <Badge variant="outline" className="text-xs">{queueStatus.stats.totalAdded} added</Badge>}
          {queueStatus.stats.totalMerged > 0 && <Badge variant="outline" className="text-xs">{queueStatus.stats.totalMerged} merged</Badge>}
          {queueStatus.stats.totalSkipped > 0 && <Badge variant="outline" className="text-xs">{queueStatus.stats.totalSkipped} skipped</Badge>}
        </div>
      )}

      {hasCompleted && scan?.lastCompletedAt && (
        <p className="text-xs text-muted-foreground">
          Last scan: {new Date(scan.lastCompletedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </p>
      )}
    </div>
  );

  const hasCandidates = allCandidates.length > 0;
  const allDone = !isScanning && queueStatus && queueStatus.pending === 0 && queueStatus.total > 0;
  const isEmpty = !isScanning && (!queueStatus || (queueStatus.total === 0 && !hasCompleted)) && gmailStatus?.readAccess;

  return (
    <div className="flex h-full" data-testid="import-view">
      <div className={`w-full @md:w-72 shrink-0 border-r flex flex-col bg-muted/30 ${selectedEmail ? "hidden @md:flex" : "flex"}`}>
        {scanControls}

        {hasCandidates && (
          <>
            <div className="p-2 border-b">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Filter candidates..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="pl-8 h-8 text-xs"
                  data-testid="input-filter-candidates"
                />
              </div>
            </div>

            <ScrollArea className="flex-1">
              <div className="p-1">
                {paginated.map(candidate => {
                  const isSelected = selectedEmail === candidate.email;
                  return (
                    <button
                      key={candidate.email}
                      type="button"
                      className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${isSelected ? "bg-accent" : "hover-elevate"}`}
                      onClick={() => setSelectedEmail(candidate.email)}
                      data-testid={`candidate-row-${candidate.email}`}
                    >
                      <span className="font-medium truncate">{candidate.name || candidate.email.split("@")[0]}</span>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>

            {totalPages > 1 && (
              <div className="p-2 border-t flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  disabled={page === 0}
                  onClick={() => setPage(p => p - 1)}
                  data-testid="button-prev-page"
                >
                  Prev
                </Button>
                <span className="text-xs text-muted-foreground">
                  {page + 1} / {totalPages}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage(p => p + 1)}
                  data-testid="button-next-page"
                >
                  Next
                </Button>
              </div>
            )}

            {(skipListData?.skipList?.length ?? 0) > 0 && (
              <div className="p-2 border-t text-center">
                <button
                  className="text-xs text-muted-foreground hover-elevate px-2 py-0.5 rounded-md"
                  onClick={() => setShowSkipListManager(!showSkipListManager)}
                  data-testid="button-manage-skip-list"
                >
                  {skipListData!.skipList.length} skipped
                </button>
              </div>
            )}
          </>
        )}

        {allDone && (
          <div className="p-4 text-center space-y-2 flex-1 flex flex-col items-center justify-center">
            <Users className="h-6 w-6 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">All reviewed</p>
            <div className="flex gap-1.5 flex-wrap justify-center">
              {queueStatus.stats.totalAdded > 0 && <Badge variant="outline" className="text-xs">{queueStatus.stats.totalAdded} added</Badge>}
              {queueStatus.stats.totalMerged > 0 && <Badge variant="outline" className="text-xs">{queueStatus.stats.totalMerged} merged</Badge>}
              {queueStatus.stats.totalSkipped > 0 && <Badge variant="outline" className="text-xs">{queueStatus.stats.totalSkipped} skipped</Badge>}
            </div>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => resetMutation.mutate()} data-testid="button-clear-queue">
              Clear Queue
            </Button>
          </div>
        )}

        {isEmpty && !hasCandidates && (
          <div className="p-4 text-center flex-1 flex flex-col items-center justify-center">
            <Mail className="h-6 w-6 text-muted-foreground/20 mb-2" />
            <p className="text-xs text-muted-foreground">Scan your inbox to find contacts.</p>
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {selectedEmail && selectedCandidate ? (
          <>
            <div className="flex items-center gap-2 p-2 border-b @md:hidden">
              <Button size="icon" variant="ghost" onClick={() => setSelectedEmail(null)} data-testid="button-back-to-candidates">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </div>
            <ImportCandidateDetail
              candidate={selectedCandidate}
              levels={levels}
              existingPeople={existingPeople?.people || []}
              onDecide={(params) => decideMutation.mutate(params)}
              isPending={decideMutation.isPending}
            />
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Mail className="h-12 w-12 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Select a candidate to review</p>
            </div>
          </div>
        )}
      </div>

      {showSkipListManager && skipListData?.skipList && skipListData.skipList.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowSkipListManager(false)}>
          <Card className="w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <CardContent className="pt-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">Skipped Contacts</span>
                <Button variant="ghost" size="icon" onClick={() => setShowSkipListManager(false)} data-testid="button-close-skip-list">
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1">
                {skipListData.skipList.map(entry => (
                  <div key={entry.email} className="flex items-center justify-between gap-2 text-xs py-1" data-testid={`skip-entry-${entry.email}`}>
                    <div className="min-w-0">
                      {entry.name && <span className="font-medium mr-1">{entry.name}</span>}
                      <span className="text-muted-foreground truncate">{entry.email}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={async () => {
                        try {
                          await apiRequest("DELETE", "/api/gmail/contacts/skip-list", { emails: [entry.email] });
                          refetchSkipList();
                          toast({ title: `${entry.name || entry.email} will appear in future scans` });
                        } catch {}
                      }}
                      data-testid={`button-unskip-${entry.email}`}
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function DetailTagPicker({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(tags.length);
  const summaryRef = useRef<HTMLDivElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const { data: tagData } = useQuery<{ tags: { slug: string; label: string }[] }>({
    queryKey: ["/api/tags"],
  });
  const allTags = tagData?.tags || [];
  const suggestions = input.length > 0
    ? allTags.filter(t => t.label.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t.slug)).slice(0, 5)
    : [];

  useLayoutEffect(() => {
    const summary = summaryRef.current;
    const measurement = measurementRef.current;
    const overflowButton = overflowButtonRef.current;
    if (!summary || !measurement || !overflowButton) return;

    const updateVisibleCount = () => {
      const widths = Array.from(measurement.children).map(child => (child as HTMLElement).offsetWidth);
      const gap = 4;
      const availableWidth = summary.clientWidth;
      const overflowWidth = overflowButton.offsetWidth;
      const allTagsWidth = widths.reduce((total, width) => total + width, 0) + widths.length * gap + overflowWidth;

      if (allTagsWidth <= availableWidth) {
        setVisibleCount(tags.length);
        return;
      }

      let occupiedWidth = overflowWidth;
      let nextVisibleCount = 0;
      for (const width of widths) {
        const nextWidth = occupiedWidth + gap + width;
        if (nextWidth > availableWidth) break;
        occupiedWidth = nextWidth;
        nextVisibleCount += 1;
      }
      setVisibleCount(nextVisibleCount);
    };

    updateVisibleCount();
    const observer = new ResizeObserver(updateVisibleCount);
    observer.observe(summary);
    return () => observer.disconnect();
  }, [tags]);

  const addTag = (value: string) => {
    const slug = value.trim().toLowerCase().replace(/\s+/g, "-");
    if (!slug) return;
    if (!tags.includes(slug)) onChange([...tags, slug]);
    setInput("");
  };

  const hasOverflow = visibleCount < tags.length;

  return (
    <Popover open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (!nextOpen) setInput(""); }}>
      <div ref={summaryRef} className="relative flex h-5 w-48 min-w-0 items-center justify-end gap-1 overflow-hidden" data-testid="detail-tags-summary">
        <div ref={measurementRef} aria-hidden className="pointer-events-none absolute left-0 top-0 flex invisible items-center gap-1">
          {tags.map(tag => <Badge key={tag} variant="outline" className="h-5 px-1.5 py-0 text-xs">{tag}</Badge>)}
        </div>
        {tags.slice(0, visibleCount).map(tag => (
          <Badge key={tag} variant="outline" className="h-5 max-w-full shrink-0 overflow-hidden px-1.5 py-0 text-xs" data-testid={`badge-tag-${tag}`}>
            <span className="truncate">{tag}</span>
          </Badge>
        ))}
        <PopoverTrigger asChild>
          <button
            ref={overflowButtonRef}
            type="button"
            className="inline-flex h-5 shrink-0 items-center rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={hasOverflow ? `Show all ${tags.length} tags` : "Edit tags"}
            data-testid={hasOverflow ? "button-tags-overflow" : "button-edit-tags"}
          >
            {hasOverflow ? "..." : <Plus className="h-3 w-3" />}
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent align="end" className="w-64 space-y-2 p-2" onOpenAutoFocus={(event) => event.preventDefault()} data-testid="popover-detail-tags">
        <div className="max-h-48 overflow-y-auto">
          {tags.length > 0 ? tags.map(tag => (
            <div key={tag} className="flex min-h-8 items-center justify-between gap-2 rounded px-2 text-sm hover:bg-accent">
              <span className="min-w-0 truncate">{tag}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 min-h-7 w-7 shrink-0 px-0"
                onClick={() => onChange(tags.filter(existingTag => existingTag !== tag))}
                aria-label={`Remove ${tag}`}
                data-testid={`button-remove-tag-${tag}`}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          )) : <div className="px-2 py-1.5 text-sm text-muted-foreground">No tags</div>}
        </div>
        <div className="relative border-t border-border/20 pt-2">
          <Input
            value={input}
            onChange={event => setInput(event.target.value)}
            placeholder="Add tag"
            className="h-8 w-full text-left text-sm"
            onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault();
                addTag(input);
              }
              if (event.key === "Escape") setOpen(false);
            }}
            data-testid="input-detail-tags"
          />
          {suggestions.length > 0 && (
            <div className="mt-1 overflow-hidden rounded-md border bg-popover shadow-md">
              {suggestions.map(suggestion => (
                <button
                  type="button"
                  key={suggestion.slug}
                  className="block min-h-8 w-full px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => addTag(suggestion.slug)}
                  data-testid={`option-tag-${suggestion.slug}`}
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ImportTagPicker({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [input, setInput] = useState("");
  const { data: tagData } = useQuery<{ tags: { slug: string; label: string }[] }>({
    queryKey: ["/api/tags"],
  });
  const allTags = tagData?.tags || [];
  const suggestions = input.length > 0
    ? allTags.filter(t => t.label.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t.slug)).slice(0, 5)
    : [];

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {tags.map(t => (
          <Badge key={t} variant="outline" className="text-xs">
            {t}
            <button className="ml-1" onClick={() => onChange(tags.filter(x => x !== t))}>
              <X className="h-2.5 w-2.5" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="relative">
        <Input
          placeholder="Add tags..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && input.trim()) {
              e.preventDefault();
              const slug = input.trim().toLowerCase().replace(/\s+/g, "-");
              if (!tags.includes(slug)) onChange([...tags, slug]);
              setInput("");
            }
          }}
          data-testid="input-import-tags"
        />
        {suggestions.length > 0 && (
          <div className="absolute top-full left-0 right-0 z-10 border rounded-md bg-popover mt-1 divide-y">
            {suggestions.map(s => (
              <div
                key={s.slug}
                className="px-2 py-1.5 text-xs cursor-pointer hover-elevate"
                onClick={() => {
                  if (!tags.includes(s.slug)) onChange([...tags, s.slug]);
                  setInput("");
                }}
              >
                {s.label}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DesktopPlaceholder() {
  return (
    <div className="flex items-center justify-center h-full" data-testid="detail-placeholder">
      <div className="text-center">
        <Users className="h-12 w-12 text-muted-foreground/20 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">Select a person to view their details</p>
      </div>
    </div>
  );
}

export default function PeoplePage() {
  const { toast } = useToast();
  const [, params] = useRoute("/people/:id");
  const [location, setLocation] = useLocation();
  const [selectedPersonId, setSelectedPersonIdRaw] = useState<string | null>(params?.id && params.id !== "import" && params.id !== "network" ? params.id : null);
  const [activeTab, setActiveTabRaw] = useState("contacts");
  const [selectedImportEmail, setSelectedImportEmail] = useState<string | null>(null);
  const [listSearch, setListSearch] = useState("");
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("lastInteraction");
  const canImportIosContacts = hasNativeWebViewBridge();

  const handleImportIosContacts = useCallback(() => {
    if (requestIosContactsImport()) {
      toast({ title: "Opening iOS Contacts import" });
      return;
    }

    toast({
      title: "Open the mobile app to import iOS contacts",
      description: "iOS Contacts are available only inside the native mobile app.",
    });
  }, [toast]);

  const setSelectedPersonId = useCallback((id: string | null) => {
    setSelectedPersonIdRaw(id);
    setSelectedImportEmail(null);
    if (id) {
      setLocation(`/people/${id}`);
      // Mark person as viewed to clear unread state
      apiRequest("POST", `/api/people/${id}/viewed`).then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      }).catch(() => { /* non-critical */ });
    } else {
      setLocation(`/people`);
    }
  }, [setLocation]);

  useEffect(() => {
    if (params?.id === "network" || params?.id === "import") {
      setActiveTabRaw("contacts");
      setSelectedPersonIdRaw(null);
      setSelectedImportEmail(null);
      setLocation("/people");
      return;
    }
    if (params?.id && params.id !== selectedPersonId) {
      setActiveTabRaw("contacts");
      setSelectedImportEmail(null);
      setSelectedPersonIdRaw(params.id);
      // Mark person as viewed on direct navigation
      apiRequest("POST", `/api/people/${params.id}/viewed`).then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      }).catch(() => { /* non-critical */ });
    }
  }, [params?.id, selectedPersonId, setLocation]);

  const setActiveTab = useCallback((_tab: string) => {
    setActiveTabRaw("contacts");
    setLocation(selectedPersonId ? `/people/${selectedPersonId}` : "/people");
  }, [selectedPersonId, setLocation]);

  const { data: simpleFeed } = useQuery<SimpleFeed>({
    queryKey: ["/api/home/feed"],
    refetchInterval: 60_000,
  });

  const { data: headerPeopleData } = useQuery<{ people: PersonIndex[] }>({
    queryKey: ["/api/people"],
    refetchInterval: 10000,
  });

  const selectedPersonName = useMemo(() => {
    if (!selectedPersonId) return null;
    return headerPeopleData?.people.find(person => person.id === selectedPersonId)?.name ?? null;
  }, [headerPeopleData?.people, selectedPersonId]);

  const shouldOpenNewInteraction = useMemo(() => {
    if (!selectedPersonId || typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("action") === "log-interaction";
  }, [location, selectedPersonId]);

  const handleNewInteractionOpened = useCallback(() => {
    if (!selectedPersonId) return;
    setLocation(`/people/${selectedPersonId}`, { replace: true });
  }, [selectedPersonId, setLocation]);

  const peopleTabs = useMemo(() => [
    { value: "contacts", label: "Contacts", testId: "tab-contacts", icon: <ContactRound className="h-3.5 w-3.5" /> },
  ], []);

  const profileHeaderContent = useMemo(() => {
    if (!selectedPersonId) return undefined;

    return (
      <div className="flex min-w-0 items-center gap-1 text-sm font-medium text-foreground">
        <button
          type="button"
          className="shrink-0 text-muted-foreground transition-colors hover:text-cta focus-visible:outline-none focus-visible:text-cta"
          onClick={() => setSelectedPersonId(null)}
          aria-label="Back to People"
          data-testid="button-people-breadcrumb"
        >
          People
        </button>
        <span className="shrink-0 text-muted-foreground/60">/</span>
        <span className="truncate">{selectedPersonName ?? "Person"}</span>
      </div>
    );
  }, [selectedPersonId, selectedPersonName, setSelectedPersonId]);

  usePageHeader({
    title: selectedPersonId ? `People / ${selectedPersonName ?? "Person"}` : "People",
    customContent: profileHeaderContent,
    tabs: selectedPersonId ? undefined : peopleTabs,
    activeTab: selectedPersonId ? undefined : activeTab,
    onTabChange: selectedPersonId ? undefined : setActiveTab,
  });

  useFocusContext(selectedPersonId ? null : { subView: activeTab });

  return (
    <div className="flex h-full bg-black" data-testid="people-page">
      <div className={`w-full @md:w-64 shrink-0 flex flex-col bg-black ${selectedPersonId || selectedImportEmail ? "hidden @md:flex" : "flex"}`}>
        <div className="p-2">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                placeholder="Search people..."
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                className="w-full h-7 pl-7 pr-7 rounded-md border border-input bg-background text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-testid="input-search-people"
              />
              {listSearch && (
                <button
                  onClick={() => setListSearch("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                  data-testid="button-clear-people-search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md border border-input bg-background text-muted-foreground hover:bg-accent/70 hover:text-foreground transition-colors"
                  aria-label="People settings"
                  data-testid="button-people-settings"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={() => setSortMode(sortMode === "lastInteraction" ? "name" : "lastInteraction")}
                  data-testid="menu-sort-people"
                >
                  <SlidersHorizontal className="mr-2 h-3.5 w-3.5" />
                  <span className="flex-1">Sort By</span>
                  <span className="text-xs text-muted-foreground">
                    {sortMode === "lastInteraction" ? "Last Contact" : "Name"}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleImportIosContacts}
                  disabled={!canImportIosContacts}
                  data-testid="menu-import-ios-contacts"
                >
                  <Smartphone className="mr-2 h-3.5 w-3.5" />
                  <span className="flex-1">Import iOS Contacts</span>
                  {!canImportIosContacts && (
                    <span className="text-xs text-muted-foreground">Mobile</span>
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2">
            <PeopleListView
              selectedId={selectedPersonId}
              onSelect={setSelectedPersonId}
              searchOverride={listSearch}
              showQuickAddOverride={showQuickAdd}
              onQuickAddClose={() => setShowQuickAdd(false)}
              onRequestQuickAdd={() => setShowQuickAdd(true)}
              sortMode={sortMode}
              simpleFeed={simpleFeed}
              selectedImportEmail={selectedImportEmail}
              onSelectImportCandidate={(email) => {
                setSelectedPersonIdRaw(null);
                setSelectedImportEmail(email);
                setLocation("/people");
              }}
            />
          </div>
        </ScrollArea>
      </div>

      <div className={`flex-1 flex flex-col min-w-0 ${selectedPersonId || selectedImportEmail ? "flex" : "hidden @md:flex"}`}>
        {selectedPersonId ? (
          <>
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              <div className="p-4">
                <PersonDetailView
                  personId={selectedPersonId}
                  onClose={() => setSelectedPersonId(null)}
                  onDelete={() => setSelectedPersonId(null)}
                  openNewInteraction={shouldOpenNewInteraction}
                  onNewInteractionOpened={handleNewInteractionOpened}
                />
              </div>
            </div>
          </>
        ) : selectedImportEmail ? (
          <ImportView
            selectedEmailOverride={selectedImportEmail}
            onClearSelection={() => setSelectedImportEmail(null)}
            onSelectPerson={setSelectedPersonId}
          />
        ) : (
          <DesktopPlaceholder />
        )}
      </div>
    </div>
  );
}
