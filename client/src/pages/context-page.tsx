import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { getInstanceName } from "@/lib/instance-config";
import remarkGfm from "remark-gfm";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import {
  ChevronRight,
  ChevronDown,
  Clock,
  FileText,
  Layers,
  ArrowLeft,
  Loader2,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import type {
  SpineMetadata,
  ContextCallType,
  LlmMode,
} from "../../../shared/context-spine";

interface UnifiedPreset {
  key: string;
  label: string;
  callType: ContextCallType;
  llmMode: LlmMode;
  includeSections: string[];
  excludeSections: string[];
}

const STANDARD_PRESETS: UnifiedPreset[] = [
  { key: "full-text", label: "Full / Text", callType: "full", llmMode: "text", includeSections: [], excludeSections: [] },
  { key: "full-voice", label: "Full / Voice", callType: "full", llmMode: "voice", includeSections: [], excludeSections: [] },
  { key: "world-text", label: "World / Text", callType: "world", llmMode: "text", includeSections: [], excludeSections: [] },
  { key: "internal-text", label: "Internal / Text", callType: "internal", llmMode: "text", includeSections: [], excludeSections: [] },
];

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatModelName(modelId: string): string {
  const name = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  return name.replace(/-\d{8}$/, "");
}

function SummaryBar({ metadata }: { metadata: SpineMetadata }) {
  const usagePct = metadata.contextWindow && metadata.contextWindow > 0
    ? Math.min((metadata.totalTokens / metadata.contextWindow) * 100, 100)
    : null;

  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0" data-testid="context-summary-bar">
      <span className="flex items-center gap-1" data-testid="text-section-count">
        <Layers className="h-3 w-3" />
        {metadata.activeSectionCount}/{metadata.sectionCount} sections
      </span>
      {metadata.placeholderCount > 0 && (
        <span className="flex items-center gap-1" data-testid="text-placeholder-count">
          <FileText className="h-3 w-3" />
          {metadata.placeholderCount} placeholders
        </span>
      )}
      {metadata.contextWindow && metadata.modelId && usagePct !== null && (
        <>
          <span data-testid="text-model-info">
            {formatModelName(metadata.modelId)} / {metadata.modelTier} tier
          </span>
          <span className="tabular-nums" data-testid="text-usage-ratio">
            {formatTokens(metadata.totalTokens)} / {formatTokens(metadata.contextWindow)} ({usagePct.toFixed(1)}%)
          </span>
        </>
      )}
    </div>
  );
}

function statusClass(loaded: boolean, required: boolean): string {
  if (loaded) return "text-emerald-600 dark:text-emerald-400";
  return required ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
}

function RuntimeCard({ metadata }: { metadata: SpineMetadata }) {
  const coding = metadata.codingContext;
  return (
    <Card className="flex-1 min-h-0 overflow-auto">
      <div className="p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Runtime</h2>
        </div>
        {coding && (
          <div className="rounded-lg border border-border/30 p-3 space-y-3" data-testid="card-coding-context">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">Coding context</h3>

              </div>
              <span className="text-xs rounded-full border px-2 py-0.5">always-on</span>
            </div>
            <div className="space-y-2">
              {coding.requiredReferences.map(ref => (
                <div key={ref.id} className="flex items-start justify-between gap-3 text-xs border-t border-border/20 pt-2 first:border-t-0 first:pt-0">
                  <div>
                    <div className="font-medium">{ref.label}</div>
                    {ref.source && <div className="text-muted-foreground font-mono">{ref.source}</div>}
                    {ref.evidence?.[0] && <div className="text-muted-foreground">{ref.evidence[0]}</div>}
                  </div>
                  <div className={statusClass(ref.loaded, ref.required)}>
                    {ref.loaded ? "loaded" : ref.required ? "loads at tool boundary" : "on demand"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {!coding && <p className="text-sm text-muted-foreground">No coding context metadata recorded for this render.</p>}
      </div>
    </Card>
  );
}

function InstructionsCard({ metadata }: { metadata: SpineMetadata }) {
  return (
    <Card className="flex-1 min-h-0 overflow-auto">
      <div className="p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Instructions</h2>
        </div>
        <div className="space-y-3">
          {(metadata.instructionGroups || []).map(group => (
            <div key={group.id} className="rounded-lg border border-border/30 p-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium">{group.title}</div>
                <div className="text-muted-foreground tabular-nums">{formatTokens(group.tokenCount)} tokens</div>
              </div>
              <div className="font-mono text-muted-foreground mt-1">{group.id}</div>
              <div className="text-muted-foreground mt-1">{group.sectionIds.join(", ")}</div>
            </div>
          ))}
          {(metadata.instructionGroups || []).length === 0 && <p className="text-sm text-muted-foreground">No instruction groups recorded.</p>}
        </div>
        {(metadata.references || []).length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">References</h3>
            {metadata.references?.map(ref => (
              <div key={ref.id} className="rounded-md border border-border/30 p-2 text-xs">
                <div className="font-medium">{ref.title}</div>
                <div className="font-mono text-muted-foreground">{ref.id}</div>
                <div className="text-muted-foreground">{ref.reason}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

interface ParsedSection {
  id: string;
  title: string;
  content: string;
  children: ParsedSection[];
  depth: number;
}

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function extractReadableContent(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return unescapeXml(node.textContent || "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  if (tag === "section") return "";

  if (tag === "entry") {
    const entryTitle = el.getAttribute("title");
    const entrySource = el.getAttribute("source");
    const entryId = el.getAttribute("id");
    const inner = Array.from(el.childNodes).map(extractReadableContent).join("").trim();
    if (entryTitle) {
      const label = entrySource ? ` [${entrySource}]` : "";
      return `\n**${entryTitle}**${label}\n${inner}\n`;
    }
    if (entryId) {
      return `\n---\n${inner}\n`;
    }
    return `\n${inner}\n`;
  }

  if (tag === "turn") {
    const role = el.getAttribute("role") || "unknown";
    const name = el.getAttribute("name");
    const inner = Array.from(el.childNodes).map(extractReadableContent).join("").trim();
    const label = name || (role === "user" ? "User" : role === "assistant" ? getInstanceName() : role === "tools" ? "Tools" : role === "thinking" ? "Thinking" : role);
    return `\n**${label}:** ${inner}\n`;
  }

  return Array.from(el.childNodes).map(extractReadableContent).join("");
}

function findSectionsDeep(el: Element, depth: number): ParsedSection[] {
  const results: ParsedSection[] = [];
  for (const child of Array.from(el.children)) {
    if (child.tagName.toLowerCase() === "section") {
      const id = child.getAttribute("id") || "";
      const title = child.getAttribute("title") || id;
      const childSections = findSectionsDeep(child, depth + 1);
      const contentParts: string[] = [];
      for (const node of Array.from(child.childNodes)) {
        contentParts.push(extractReadableContent(node));
      }
      const content = contentParts.join("").trim();
      results.push({ id, title, content, children: childSections, depth });
    } else {
      results.push(...findSectionsDeep(child, depth));
    }
  }
  return results;
}

function parseRenderedPrompt(raw: string): { sections: ParsedSection[]; parseFailed: boolean } {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(raw, "text/html");
    const sections = findSectionsDeep(doc.body, 0);
    if (sections.length === 0) return { sections: [], parseFailed: true };
    return { sections, parseFailed: false };
  } catch {
    return { sections: [], parseFailed: true };
  }
}

function collectAllIds(sections: ParsedSection[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: ParsedSection[]) => {
    for (const s of list) {
      ids.add(s.id);
      walk(s.children);
    }
  };
  walk(sections);
  return ids;
}

function buildParentMap(sections: ParsedSection[]): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (list: ParsedSection[], parentId: string | null) => {
    for (const s of list) {
      if (parentId) map.set(s.id, parentId);
      walk(s.children, s.id);
    }
  };
  walk(sections, null);
  return map;
}

function getAncestorChain(id: string, parentMap: Map<string, string>): string[] {
  const chain: string[] = [];
  let current = parentMap.get(id);
  while (current) {
    chain.push(current);
    current = parentMap.get(current);
  }
  return chain;
}

const depthColors = [
  "border-l-primary/40",
  "border-l-active/40",
  "border-l-success/40",
  "border-l-warning/40",
  "border-l-cat-ai/40",
];

const depthHeadingSize = [
  "text-base font-semibold",
  "text-sm font-semibold",
  "text-sm font-medium",
  "text-xs font-medium",
  "text-xs font-medium",
];

function TocNode({
  section,
  expanded,
  activeId,
  onToggle,
  onNavigate,
}: {
  section: ParsedSection;
  expanded: Set<string>;
  activeId: string | null;
  onToggle: (id: string) => void;
  onNavigate: (id: string) => void;
}) {
  const isExpanded = expanded.has(section.id);
  const isActive = activeId === section.id;
  const hasChildren = section.children.length > 0;

  return (
    <div style={{ paddingLeft: section.depth > 0 ? 12 : 0 }} data-testid={`toc-node-${section.id}`}>
      <div
        className={`flex items-center gap-0.5 w-full text-left py-1 px-1.5 rounded text-xs transition-colors ${
          isActive
            ? "bg-primary/10 text-primary font-medium"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
        }`}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggle(section.id); }}
            className="p-0.5 rounded hover:bg-muted/80 shrink-0"
            data-testid={`toc-toggle-${section.id}`}
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onNavigate(section.id)}
          className="truncate text-left flex-1"
          data-testid={`toc-button-${section.id}`}
        >
          {section.title}
        </button>
      </div>
      {hasChildren && isExpanded && (
        <div>
          {section.children.map(child => (
            <TocNode
              key={child.id}
              section={child}
              expanded={expanded}
              activeId={activeId}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ContentSection({
  section,
  expanded,
  sectionRefs,
}: {
  section: ParsedSection;
  expanded: Set<string>;
  sectionRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
}) {
  const isExpanded = expanded.has(section.id);
  const borderColor = depthColors[Math.min(section.depth, depthColors.length - 1)];
  const headingSize = depthHeadingSize[Math.min(section.depth, depthHeadingSize.length - 1)];

  const refCallback = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      sectionRefs.current.set(section.id, el);
    } else {
      sectionRefs.current.delete(section.id);
    }
  }, [section.id, sectionRefs]);

  return (
    <div
      ref={refCallback}
      id={`content-${section.id}`}
      className={`border-l-2 ${borderColor} pl-3 py-1.5`}
      data-testid={`formatted-section-${section.id}`}
    >
      <div className={`${headingSize} text-foreground mb-1`}>
        {section.title}
        <span className="ml-2 text-xs font-normal text-muted-foreground/50">{section.id}</span>
      </div>
      {isExpanded && (
        <>
          {section.content && (
            <div className="text-sm text-foreground/85 leading-relaxed prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-hr:my-2 prose-blockquote:my-1">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown>
            </div>
          )}
          {section.children.length > 0 && (
            <div className="mt-2 space-y-2">
              {section.children.map(child => (
                <ContentSection
                  key={child.id}
                  section={child}
                  expanded={expanded}
                  sectionRefs={sectionRefs}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function findSectionById(sections: ParsedSection[], id: string): ParsedSection | null {
  for (const s of sections) {
    if (s.id === id) return s;
    const found = findSectionById(s.children, id);
    if (found) return found;
  }
  return null;
}

function TwoColumnPrompt({ rendered }: { rendered: string }) {
  const isMobile = useIsMobile();
  const { sections, parseFailed } = useMemo(() => parseRenderedPrompt(rendered), [rendered]);
  const allIds = useMemo(() => collectAllIds(sections), [sections]);
  const parentMap = useMemo(() => buildParentMap(sections), [sections]);
  const [expanded, setExpanded] = useState<Set<string>>(() => collectAllIds(sections));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mobileSelectedId, setMobileSelectedId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const isScrollingRef = useRef(false);

  useEffect(() => {
    setExpanded(collectAllIds(sections));
  }, [sections]);

  const handleToggle = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleNavigate = useCallback((id: string) => {
    if (isMobile) {
      setMobileSelectedId(id);
      setActiveId(id);
      return;
    }
    const ancestors = getAncestorChain(id, parentMap);
    setExpanded(prev => {
      const next = new Set(prev);
      next.add(id);
      for (const a of ancestors) next.add(a);
      return next;
    });
    setActiveId(id);
    requestAnimationFrame(() => {
      const el = sectionRefs.current.get(id);
      if (el && contentRef.current) {
        isScrollingRef.current = true;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setTimeout(() => { isScrollingRef.current = false; }, 800);
      }
    });
  }, [parentMap, isMobile]);

  useEffect(() => {
    if (isMobile) return;
    const container = contentRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (isScrollingRef.current) return;
        let topMost: { id: string; top: number } | null = null;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.id.replace("content-", "");
            const top = entry.boundingClientRect.top;
            if (!topMost || top < topMost.top) {
              topMost = { id, top };
            }
          }
        }
        if (topMost) {
          setActiveId(topMost.id);
        }
      },
      {
        root: container,
        rootMargin: "-10% 0px -80% 0px",
        threshold: 0,
      }
    );

    const refs = sectionRefs.current;
    for (const el of refs.values()) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [sections, expanded, isMobile]);

  useEffect(() => {
    if (!isMobile && mobileSelectedId) {
      setActiveId(mobileSelectedId);
      setMobileSelectedId(null);
      const ancestors = getAncestorChain(mobileSelectedId, parentMap);
      setExpanded(prev => {
        const next = new Set(prev);
        next.add(mobileSelectedId);
        for (const a of ancestors) next.add(a);
        return next;
      });
      requestAnimationFrame(() => {
        const el = sectionRefs.current.get(mobileSelectedId);
        if (el && contentRef.current) {
          isScrollingRef.current = true;
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          setTimeout(() => { isScrollingRef.current = false; }, 800);
        }
      });
    }
  }, [isMobile, mobileSelectedId, parentMap]);

  if (parseFailed) {
    return (
      <Card className="overflow-hidden">
        <div className="py-3 px-3">
          <p className="text-xs text-muted-foreground mb-2" data-testid="text-parse-fallback">
            Could not format prompt — showing raw output.
          </p>
          <pre className="text-xs whitespace-pre-wrap font-mono bg-muted/30 rounded-md p-4 overflow-auto scrollbar-thin max-h-[70vh] text-foreground/90">
            {rendered}
          </pre>
        </div>
      </Card>
    );
  }

  if (isMobile) {
    const selectedSection = mobileSelectedId ? findSectionById(sections, mobileSelectedId) : null;

    if (selectedSection) {
      const mobileContentExpanded = new Set(collectAllIds([selectedSection]));
      return (
        <div className="border border-border/30 rounded-lg overflow-hidden" data-testid="formatted-prompt-mobile-content">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border/20 bg-white/[0.02]">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => { setMobileSelectedId(null); setActiveId(null); }}
              data-testid="button-mobile-back"
            >
              <ArrowLeft className="h-3.5 w-3.5 mr-1" />
              Back
            </Button>
            <span className="text-sm font-medium truncate">{selectedSection.title}</span>
          </div>
          <div className="overflow-y-auto scrollbar-thin p-3 space-y-3 max-h-[calc(100vh-320px)]" data-testid="mobile-content-pane">
            <ContentSection
              section={selectedSection}
              expanded={mobileContentExpanded}
              sectionRefs={sectionRefs}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="border border-border/30 rounded-lg overflow-hidden" data-testid="formatted-prompt-mobile-toc">
        <div className="px-3 py-2 border-b border-border/20 bg-white/[0.02]">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
              Table of Contents
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-6 px-2"
                onClick={() => setExpanded(new Set(allIds))}
                data-testid="button-expand-all"
              >
                Expand All
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-6 px-2"
                onClick={() => setExpanded(new Set())}
                data-testid="button-collapse-all"
              >
                Collapse All
              </Button>
            </div>
          </div>
        </div>
        <div className="overflow-y-auto scrollbar-thin py-2 px-1 max-h-[calc(100vh-320px)]" data-testid="mobile-toc-list">
          {sections.map(section => (
            <TocNode
              key={section.id}
              section={section}
              expanded={expanded}
              activeId={activeId}
              onToggle={handleToggle}
              onNavigate={handleNavigate}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex border border-border/30 rounded-lg overflow-hidden flex-1 min-h-0" data-testid="formatted-prompt">
      <div
        className="w-[260px] shrink-0 border-r border-border/20 overflow-y-auto scrollbar-thin bg-white/[0.02] py-2 px-1"
        data-testid="toc-sidebar"
      >
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest px-2 mb-2">
          Table of Contents
        </div>
        {sections.map(section => (
          <TocNode
            key={section.id}
            section={section}
            expanded={expanded}
            activeId={activeId}
            onToggle={handleToggle}
            onNavigate={handleNavigate}
          />
        ))}
        <div className="mt-3 px-2 pt-2 border-t border-border/20">
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-6 px-2"
              onClick={() => setExpanded(new Set(allIds))}
              data-testid="button-expand-all"
            >
              Expand All
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-6 px-2"
              onClick={() => setExpanded(new Set())}
              data-testid="button-collapse-all"
            >
              Collapse All
            </Button>
          </div>
        </div>
      </div>
      <div
        ref={contentRef}
        className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3"
        data-testid="content-pane"
      >
        {sections.map(section => (
          <ContentSection
            key={section.id}
            section={section}
            expanded={expanded}
            sectionRefs={sectionRefs}
          />
        ))}
      </div>
    </div>
  );
}

export default function ContextPage({ embedded }: { embedded?: boolean } = {}) {
  usePageHeader({ title: "Context", skip: !!embedded });
  const [callType, setCallType] = useState<ContextCallType>("full");
  const [llmMode, setLlmMode] = useState<LlmMode>("text");
  const [viewTab, setViewTab] = useState("runtime");
  const [includeSections, setIncludeSections] = useState<string[]>([]);
  const [excludeSections, setExcludeSections] = useState<string[]>([]);
  const [activePreset, setActivePreset] = useState<string>("full-text");
  const [memoryQuery, setMemoryQuery] = useState("");
  const [debouncedMemoryQuery, setDebouncedMemoryQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedMemoryQuery(memoryQuery);
    }, 500);
    return () => clearTimeout(timer);
  }, [memoryQuery]);

  const unifiedPresets = STANDARD_PRESETS;

  const includeParam = includeSections.length > 0 ? includeSections.join(",") : "";
  const excludeParam = excludeSections.length > 0 ? excludeSections.join(",") : "";

  const renderedQuery = useQuery<{ rendered: string; metadata: SpineMetadata }>({
    queryKey: ["/api/context/preview/rendered", callType, llmMode, includeParam, excludeParam, debouncedMemoryQuery],
    queryFn: async () => {
      const params = new URLSearchParams({ callType, llmMode });
      if (includeParam) params.set("includeSections", includeParam);
      if (excludeParam) params.set("excludeSections", excludeParam);
      if (debouncedMemoryQuery.trim()) params.set("memoryQuery", debouncedMemoryQuery.trim());
      const res = await fetch(`/api/context/preview/rendered?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load rendered prompt");
      return res.json();
    },
  });

  const handlePresetSelect = (presetKey: string) => {
    const preset = unifiedPresets.find(p => p.key === presetKey);
    if (!preset) return;
    setActivePreset(presetKey);
    setCallType(preset.callType);
    setLlmMode(preset.llmMode);
    setIncludeSections(preset.includeSections);
    setExcludeSections(preset.excludeSections);
  };

  const isLoading = renderedQuery.isLoading;

  const assembledDate = renderedQuery.data?.metadata?.assembledAt
    ? new Date(renderedQuery.data.metadata.assembledAt).toLocaleString()
    : null;

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 overflow-hidden" data-testid="context-page">
      <div className="flex flex-col flex-1 min-h-0 gap-2 p-3 w-full overflow-hidden">
          <Tabs value={viewTab} onValueChange={setViewTab} className="flex flex-col flex-1 min-h-0">
            <div className="flex flex-col @sm:flex-row @sm:items-center flex-wrap gap-2 @sm:gap-3 shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Preset:</span>
                <Select value={activePreset} onValueChange={handlePresetSelect}>
                  <SelectTrigger className="w-[160px]" data-testid="select-preset">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {unifiedPresets.map(p => (
                      <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1.5" data-testid="context-experimentation">
                <Input
                  placeholder="Test memory query..."
                  value={memoryQuery}
                  onChange={(e) => setMemoryQuery(e.target.value)}
                  className="text-xs h-7 w-full @sm:w-[200px]"
                  data-testid="input-context-experiment"
                />
                {memoryQuery.trim() && memoryQuery !== debouncedMemoryQuery && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                )}
              </div>
              {assembledDate && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-assembled-at">
                  <Clock className="h-3 w-3" />
                  {assembledDate}
                </span>
              )}
              <div className="@sm:ml-auto">
                <TabsList data-testid="context-view-tabs">
                  <TabsTrigger value="runtime" data-testid="tab-runtime-view">Runtime</TabsTrigger>
                  <TabsTrigger value="instructions" data-testid="tab-instructions-view">Instructions</TabsTrigger>
                  <TabsTrigger value="prompt" data-testid="tab-prompt-view">Rendered Prompt</TabsTrigger>
                  <TabsTrigger value="raw" data-testid="tab-raw-view">Raw</TabsTrigger>
                </TabsList>
              </div>
            </div>

          {renderedQuery.data?.metadata && (
            <SummaryBar metadata={renderedQuery.data.metadata} />
          )}

            <TabsContent value="runtime" className="mt-0 flex flex-col flex-1 min-h-0">
              {isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : renderedQuery.data?.metadata ? (
                <RuntimeCard metadata={renderedQuery.data.metadata} />
              ) : null}
            </TabsContent>

            <TabsContent value="instructions" className="mt-0 flex flex-col flex-1 min-h-0">
              {isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : renderedQuery.data?.metadata ? (
                <InstructionsCard metadata={renderedQuery.data.metadata} />
              ) : null}
            </TabsContent>

            <TabsContent value="prompt" className="mt-0 flex flex-col flex-1 min-h-0">
              {isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                  ))}
                </div>
              ) : renderedQuery.isError ? (
                <Card>
                  <div className="py-8 text-center">
                    <p className="text-sm text-destructive" data-testid="text-rendered-error">
                      Failed to load rendered prompt.
                    </p>
                  </div>
                </Card>
              ) : renderedQuery.data ? (
                <TwoColumnPrompt
                  rendered={renderedQuery.data.rendered}
                />
              ) : null}
            </TabsContent>

            <TabsContent value="raw" className="mt-0 flex flex-col flex-1 min-h-0">
              {isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                  ))}
                </div>
              ) : renderedQuery.isError ? (
                <Card>
                  <div className="py-8 text-center">
                    <p className="text-sm text-destructive" data-testid="text-raw-error">
                      Failed to load rendered prompt.
                    </p>
                  </div>
                </Card>
              ) : renderedQuery.data ? (
                <div className="flex-1 min-h-0 flex flex-col py-3 px-3">
                    <pre
                      className="text-xs whitespace-pre-wrap font-mono bg-muted/30 rounded-md p-4 overflow-auto scrollbar-thin flex-1 min-h-0 text-foreground/90"
                      data-testid="text-full-prompt-raw"
                    >
                      {renderedQuery.data.rendered}
                    </pre>
                </div>
              ) : null}
            </TabsContent>
          </Tabs>
      </div>
    </div>
  );
}
