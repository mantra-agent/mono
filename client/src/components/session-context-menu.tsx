import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

/**
 * Section groups for the context menu UI.
 * Bootstrap sections are always-on and shown as disabled.
 */

interface SectionEntry {
  id: string;
  label: string;
  bootstrap?: boolean;
  defaultIncluded?: boolean;
}

interface SectionGroup {
  label: string;
  sections: SectionEntry[];
}

const SECTION_GROUPS: SectionGroup[] = [
  {
    label: "Kernel",
    sections: [
      { id: "world_model.temporal", label: "Time & Day", bootstrap: true },
      { id: "world_model.orientation", label: "Orientation Protocol", bootstrap: true },
      { id: "world_model.people.self.identity", label: "Identity", bootstrap: true },
      { id: "world_model.people.self.voice", label: "Voice", bootstrap: true },
      { id: "world_model.people.self.intentions", label: "Intentions", bootstrap: true },
      { id: "world_model.people.self.rules", label: "Hard Boundaries", defaultIncluded: true },
    ],
  },
  {
    label: "Dynamic State",
    sections: [
      { id: "world_model.people.self.persona", label: "Persona", defaultIncluded: true },
      { id: "world_model.people.self.emotional_state", label: "Emotion", defaultIncluded: true },
      { id: "world_model.people.self.emotional_expression", label: "Expression Tags", defaultIncluded: true },
      { id: "world_model.people.partner.identity", label: "Ray Identity", defaultIncluded: true },
      { id: "world_model.people.partner.goals", label: "Ray Goals", defaultIncluded: true },
      { id: "world_model.calendar", label: "High-Prep Calendar", defaultIncluded: true },
    ],
  },
  {
    label: "Instruction Groups",
    sections: [
      { id: "instructions.coding", label: "Coding Instructions" },
      { id: "instructions.library_artifact", label: "Library Artifact Instructions" },
      { id: "context.active_work", label: "Active Work Context" },
      { id: "context.relationships", label: "Relationship Context" },
      { id: "context.memory", label: "Memory Context" },
    ],
  },
  {
    label: "References",
    sections: [
      { id: "references.tools", label: "Tool Routing Reference", defaultIncluded: true },
      { id: "capabilities.skills", label: "Skills" },
      { id: "world_model.people.self.emotional_guidance", label: "Emotion Guidance Reference", defaultIncluded: true },
      { id: "world_model.people.self.principles", label: "Principles" },
      { id: "world_model.people.self.journal", label: "Journal" },
      { id: "thoughts", label: "Observations" },
      { id: "session_context", label: "Session Context" },
    ],
  },
];

interface SessionContextMenuProps {
  sessionId: string;
}

export function SessionContextMenu({ sessionId }: SessionContextMenuProps) {
  const { toast } = useToast();
  const [optimisticFlags, setOptimisticFlags] = useState<Record<string, boolean>>({});

  // Fetch current session data to read contextFlags
  const { data: sessionData } = useQuery<{ contextFlags?: Record<string, boolean> }>({
    queryKey: ["/api/sessions", sessionId],
    enabled: !!sessionId,
  });

  const currentFlags: Record<string, boolean> = {
    ...(sessionData?.contextFlags ?? {}),
    ...optimisticFlags,
  };

  const orientMutation = useMutation({
    mutationFn: async (flags: Record<string, boolean>) => {
      await apiRequest("POST", "/api/agent/tools/orient", {
        arguments: { contextFlags: flags, reasoning: "Context flags updated via UI" },
        sessionId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      setOptimisticFlags({});
    },
    onError: (err) => {
      setOptimisticFlags({});
      toast({ title: "Failed to update context", description: String(err), variant: "destructive" });
    },
  });

  const handleToggle = useCallback((sectionId: string, checked: boolean) => {
    const newFlags = { ...currentFlags, [sectionId]: checked };
    setOptimisticFlags(prev => ({ ...prev, [sectionId]: checked }));
    orientMutation.mutate(newFlags);
  }, [currentFlags, orientMutation]);

  const isChecked = (section: SectionEntry): boolean => {
    if (section.bootstrap) return true;
    if (section.id in currentFlags) return currentFlags[section.id];
    return section.defaultIncluded ?? false;
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="submenu-context">
        <Layers className="h-3.5 w-3.5 mr-2" />
        Context Attention
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64 max-h-[70vh] overflow-y-auto">
        {SECTION_GROUPS.map((group, gi) => (
          <div key={group.label}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
              {group.label}
            </DropdownMenuLabel>
            {group.sections.map((section) => (
              <label
                key={section.id}
                className="flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-accent rounded-sm"
                title={section.bootstrap ? "Always included" : undefined}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox
                  checked={isChecked(section)}
                  onCheckedChange={(checked) => {
                    if (!section.bootstrap) handleToggle(section.id, !!checked);
                  }}
                  disabled={section.bootstrap || orientMutation.isPending}
                  data-testid={`ctx-toggle-${section.id}`}
                />
                <span className="truncate">{section.label}</span>
              </label>
            ))}
          </div>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
