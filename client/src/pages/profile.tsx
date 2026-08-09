import { Suspense, useState } from "react";
import { Briefcase, ChevronRight, Compass, Loader2, TableProperties } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { usePageHeader } from "@/hooks/use-page-header";
import { lazyWithRetry } from "@/lib/lazy-with-retry";
import { cn } from "@/lib/utils";

const MissionSection = lazyWithRetry(() => import("@/pages/profile-mission-tab"));
const SkillsSection = lazyWithRetry(() => import("@/pages/profile-skills-tab"));
const ExperienceSection = lazyWithRetry(() => import("@/pages/profile-experience-tab"));

interface ProfileSection {
  id: string;
  label: string;
  icon: React.ReactNode;
  content: React.ReactNode;
}

const PROFILE_SECTIONS: ProfileSection[] = [
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

function SectionFallback() {
  return (
    <div className="flex min-h-11 items-center px-2 py-2">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
    </div>
  );
}

export default function ProfilePage() {
  usePageHeader({ title: "Profile" });

  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(["mission"]),
  );
  const setSectionOpen = (id: string, open: boolean) => {
    setExpandedSections((previous) => {
      const next = new Set(previous);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <div
      className="flex h-full min-w-0 flex-col overflow-auto bg-background p-2"
      data-testid="profile-page"
    >
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        {PROFILE_SECTIONS.map((section) => {
          const expanded = expandedSections.has(section.id);
          return (
            <Collapsible
              key={section.id}
              open={expanded}
              onOpenChange={(open) => setSectionOpen(section.id, open)}
              className="min-w-0"
              data-testid={`tree-node-${section.id}`}
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    HIERARCHY_SECTION_HEADER_CLASS,
                    "min-h-11 text-left transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    expanded && "bg-accent text-foreground",
                  )}
                  aria-label={expanded ? `Collapse ${section.label}` : `Expand ${section.label}`}
                  data-testid={`button-profile-section-${section.id}`}
                >
                  <span className="shrink-0">{section.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{section.label}</span>
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 transition-transform",
                      expanded && "rotate-90",
                    )}
                    aria-hidden="true"
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent data-testid={`tree-children-${section.id}`}>
                <HierarchyTreeRow continues={false} connectorAnchor="first-row-center">
                  <div className="min-w-0 py-2">
                    <Suspense fallback={<SectionFallback />}>
                      {section.content}
                    </Suspense>
                  </div>
                </HierarchyTreeRow>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}
