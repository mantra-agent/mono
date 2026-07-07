import { useState, Suspense } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { Compass, TableProperties, Briefcase, Loader2, ChevronRight } from "lucide-react";
import { lazyWithRetry } from "@/lib/lazy-with-retry";
import { cn } from "@/lib/utils";

const MissionSection = lazyWithRetry(() => import("@/pages/profile-mission-tab"));
const SkillsSection = lazyWithRetry(() => import("@/pages/profile-skills-tab"));
const ExperienceSection = lazyWithRetry(() => import("@/pages/profile-experience-tab"));

const INDENT_STEP = 16;

interface ProfileTreeItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  content: React.ReactNode;
}

function SectionFallback() {
  return (
    <div className="flex items-center pl-6 py-1" style={{ paddingLeft: INDENT_STEP + 24 }}>
      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/50" />
    </div>
  );
}

function ProfileTreeNode({
  item,
  expanded,
  onToggle,
}: {
  item: ProfileTreeItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="min-w-0" data-testid={`tree-node-${item.id}`}>
      {/* Row */}
      <div
        className={cn(
          "group relative flex items-center gap-2 rounded-md px-2 py-1.5 pr-16 text-xs font-bold uppercase tracking-wider w-full text-left cursor-pointer select-none transition-colors overflow-hidden",
          expanded
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
        )}
        onClick={onToggle}
        data-testid={`button-profile-section-${item.id}`}
      >
        <span className="shrink-0">{item.icon}</span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="absolute right-8 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors z-10"
          aria-label={expanded ? `Collapse ${item.label}` : `Expand ${item.label}`}
          data-testid={`button-tree-twisty-${item.id}`}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
      </div>

      {/* Expanded content — indented child with connector */}
      {expanded && (
        <div className="min-w-0" data-testid={`tree-children-${item.id}`}>
          <div className="flex min-w-0 items-stretch" style={{ paddingLeft: INDENT_STEP }}>
            {/* Connector gutter */}
            <div className="shrink-0 w-5 self-stretch relative mr-1" aria-hidden="true">
              <div className="absolute left-1/2 top-0 bottom-0 -translate-x-px border-l border-border" />
            </div>
            {/* Content */}
            <div className="flex-1 min-w-0 py-2">
              <Suspense fallback={<SectionFallback />}>
                {item.content}
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProfilePage() {
  usePageHeader({ title: "Profile" });

  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(["mission"]),
  );

  const toggle = (id: string) =>
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const items: ProfileTreeItem[] = [
    {
      id: "mission",
      label: "Mission",
      icon: <Compass className="h-3.5 w-3.5" />,
      content: <MissionSection />,
    },
    {
      id: "skills",
      label: "Skills",
      icon: <TableProperties className="h-3.5 w-3.5" />,
      content: <SkillsSection />,
    },
    {
      id: "experience",
      label: "Experience",
      icon: <Briefcase className="h-3.5 w-3.5" />,
      content: <ExperienceSection />,
    },
  ];

  return (
    <div
      className="flex flex-col h-full min-w-0 overflow-auto bg-background p-2"
      data-testid="profile-page"
    >
      <div className="space-y-0">
        {items.map((item) => (
          <ProfileTreeNode
            key={item.id}
            item={item}
            expanded={expandedSections.has(item.id)}
            onToggle={() => toggle(item.id)}
          />
        ))}
      </div>
    </div>
  );
}
