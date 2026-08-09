import { Suspense, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Briefcase, ChevronRight, Compass, Loader2, TableProperties } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
import { useAuth, type AuthPrincipal, type AuthUser } from "@/hooks/use-auth";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { lazyWithRetry } from "@/lib/lazy-with-retry";
import { queryClient } from "@/lib/queryClient";
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

  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(["mission"]),
  );
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/auth/profile-picture", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "Profile picture upload failed");
      }
      return await response.json() as { avatarObjectPath: string };
    },
    onSuccess: ({ avatarObjectPath }) => {
      queryClient.setQueryData<{ user: AuthUser; principal?: AuthPrincipal | null } | null>(["/api/auth/me"], (current) =>
        current ? { ...current, user: { ...current.user, avatarObjectPath } } : current,
      );
    },
    onError: (error: Error) => toast({
      title: "Upload failed",
      description: error.message,
      variant: "destructive",
    }),
  });

  const initials = user?.email.slice(0, 2).toUpperCase() ?? "";
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
      <div className="flex min-h-20 min-w-0 items-center gap-4 border-b border-border/20 px-2 py-2">
        <Avatar className="h-16 w-16 shrink-0">
          {user?.avatarObjectPath && (
            <AvatarImage
              src={user.avatarObjectPath}
              alt="Profile picture"
              className="object-cover"
            />
          )}
          <AvatarFallback className="text-base font-semibold">{initials}</AvatarFallback>
        </Avatar>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          className="min-h-11 bg-cta text-cta-foreground hover:bg-cta/90"
          disabled={upload.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          {upload.isPending && (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          )}
          Upload photo
        </Button>
      </div>

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
