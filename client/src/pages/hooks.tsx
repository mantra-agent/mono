import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Plus,
  ChevronDown,
  ChevronRight,
  Clock,
  Zap,
  Play,
  Loader2,
  Wrench,
  MessageSquare,
  Lightbulb,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Trash2,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useTimezone } from "@/hooks/use-timezone";
import { usePageHeader } from "@/hooks/use-page-header";

interface Hook {
  id: number;
  name: string;
  description: string | null;
  eventPattern: string;
  condition: any;
  actionType: string;
  actionConfig: any;
  cooldownSeconds: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastFiredAt?: string | null;
}

interface HookExecution {
  id: number;
  hookId: number;
  eventDbId: number | null;
  actionType: string;
  actionConfigResolved: any;
  status: string;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  triggeringEvent?: any;
}

const ACTION_TYPE_LABELS: Record<string, string> = {
  run_skill: "Run Skill",
  initiate_conversation: "Initiate Conversation",
  tool_call: "Tool Call",
};

const ACTION_TYPE_ICONS: Record<string, typeof Lightbulb> = {
  run_skill: Lightbulb,
  initiate_conversation: MessageSquare,
  tool_call: Wrench,
};

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatCooldown(seconds: number): string {
  if (seconds === 0) return "None";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  return `${Math.floor(seconds / 3600)}h`;
}

function StatusDot({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${enabled ? "bg-success" : "bg-neutral"}`}
      data-testid={`status-dot-${enabled ? "enabled" : "disabled"}`}
    />
  );
}

function HookCard({
  hook,
  onSelect,
  onToggle,
  onDelete,
}: {
  hook: Hook;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const ActionIcon = ACTION_TYPE_ICONS[hook.actionType] || Zap;

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
      onClick={onSelect}
      data-testid={`card-hook-${hook.id}`}
    >
      <StatusDot enabled={hook.enabled} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm truncate" data-testid={`text-hook-name-${hook.id}`}>
            {hook.name}
          </span>
          <Badge variant="outline" className="font-mono text-xs px-1.5 py-0" data-testid={`badge-hook-pattern-${hook.id}`}>
            {hook.eventPattern}
          </Badge>
          <span className="inline-flex items-center bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5 gap-1" data-testid={`badge-hook-action-${hook.id}`}>
            <ActionIcon className="h-2.5 w-2.5" />
            {ACTION_TYPE_LABELS[hook.actionType] || hook.actionType}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1" data-testid={`text-hook-lastfired-${hook.id}`}>
            <Clock className="h-3 w-3" />
            {formatRelativeTime(hook.lastFiredAt)}
          </span>
          <span data-testid={`text-hook-cooldown-${hook.id}`}>
            Cooldown: {formatCooldown(hook.cooldownSeconds)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <button
          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(`Delete hook "${hook.name}"?`)) {
              onDelete();
            }
          }}
          data-testid={`button-hook-delete-${hook.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <Switch
          checked={hook.enabled}
          onCheckedChange={onToggle}
          data-testid={`switch-hook-toggle-${hook.id}`}
        />
      </div>
    </div>
  );
}

function ExecutionRow({ execution }: { execution: HookExecution }) {
  const [expanded, setExpanded] = useState(false);
  const statusIcon =
    execution.status === "success" ? (
      <CheckCircle2 className="h-3 w-3 text-success" />
    ) : execution.status === "error" ? (
      <XCircle className="h-3 w-3 text-error" />
    ) : (
      <AlertCircle className="h-3 w-3 text-warning" />
    );

  return (
    <div className="border-b border-border/30 last:border-b-0" data-testid={`row-execution-${execution.id}`}>
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/20"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {statusIcon}
        <span className="text-muted-foreground tabular-nums">
          {new Date(execution.createdAt).toLocaleString()}
        </span>
        <Badge variant="outline" className="text-xs px-1 py-0">
          {execution.actionType}
        </Badge>
        <Badge
          variant={execution.status === "success" ? "secondary" : execution.status === "error" ? "destructive" : "outline"}
          className="text-xs px-1 py-0"
          data-testid={`badge-exec-status-${execution.id}`}
        >
          {execution.status}
        </Badge>
        {execution.durationMs != null && (
          <span className="text-muted-foreground/60 ml-auto">{execution.durationMs}ms</span>
        )}
      </div>
      {expanded && (
        <div className="px-3 pb-2 ml-6 space-y-2">
          {execution.errorMessage && (
            <div className="text-xs text-error bg-error/10 rounded p-2">
              {execution.errorMessage}
            </div>
          )}
          {execution.actionConfigResolved && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Resolved Action Config:</p>
              <pre className="text-xs text-muted-foreground/80 bg-muted/50 rounded-md p-2 overflow-x-auto max-h-32 overflow-y-auto">
                {JSON.stringify(execution.actionConfigResolved, null, 2)}
              </pre>
            </div>
          )}
          {execution.triggeringEvent && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Triggering Event:</p>
              <pre className="text-xs text-muted-foreground/80 bg-muted/50 rounded-md p-2 overflow-x-auto max-h-32 overflow-y-auto">
                {JSON.stringify(execution.triggeringEvent, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ALL_EVENT_NAMES = [
  "agent.thinking", "agent.run.start", "agent.run.complete", "agent.run.aborted",
  "agent.run.error", "agent.started", "agent.stopped", "agent.tool_call", "agent.tool_result",
  "chat.stream", "pulse", "system:command",
  "tactical:decided", "tactical:executed", "tactical:error", "tactical:skipped",
  "data:people_changed", "data:intention_created", "data:intention_completed",
  "data:belief_created", "data:belief_updated", "data:rule_created", "data:preference_created",
  "entries_changed", "thought.stream",
  "session_end", "voice_phase", "voice_tools_cleared",
];

function HookDetailDrawer({
  hook,
  open,
  onClose,
}: {
  hook: Hook | null;
  open: boolean;
  onClose: () => void;
}) {
  const isCreate = !hook;
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [eventPattern, setEventPattern] = useState("");
  const [conditionStr, setConditionStr] = useState("");
  const [conditionError, setConditionError] = useState("");
  const [actionType, setActionType] = useState("run_skill");
  const [cooldownValue, setCooldownValue] = useState(0);
  const [cooldownUnit, setCooldownUnit] = useState("seconds");
  const [enabled, setEnabled] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [executionsOpen, setExecutionsOpen] = useState(false);
  const [eventPatternSuggestions, setEventPatternSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [skillName, setSkillName] = useState("");
  const [preContext, setPreContext] = useState("");
  const [topic, setTopic] = useState("");
  const [message, setMessage] = useState("");
  const [toolName, setToolName] = useState("");
  const [toolArgs, setToolArgs] = useState("{}");

  const [testEventId, setTestEventId] = useState("");
  const [testResult, setTestResult] = useState<any>(null);

  const resetForm = (h: Hook | null) => {
    if (h) {
      setName(h.name);
      setDescription(h.description || "");
      setEventPattern(h.eventPattern);
      setConditionStr(h.condition ? JSON.stringify(h.condition, null, 2) : "");
      setActionType(h.actionType);
      setEnabled(h.enabled);
      const cs = h.cooldownSeconds;
      if (cs >= 3600 && cs % 3600 === 0) {
        setCooldownValue(cs / 3600);
        setCooldownUnit("hours");
      } else if (cs >= 60 && cs % 60 === 0) {
        setCooldownValue(cs / 60);
        setCooldownUnit("minutes");
      } else {
        setCooldownValue(cs);
        setCooldownUnit("seconds");
      }
      const cfg = h.actionConfig || {};
      if (h.actionType === "run_skill") {
        setSkillName(cfg.skillName || "");
        setPreContext(cfg.preContext || "");
      } else if (h.actionType === "initiate_conversation") {
        setTopic(cfg.topic || "");
        setMessage(cfg.message || "");
      } else if (h.actionType === "tool_call") {
        setToolName(cfg.toolName || "");
        setToolArgs(cfg.arguments ? JSON.stringify(cfg.arguments, null, 2) : "{}");
      }
    } else {
      setName("");
      setDescription("");
      setEventPattern("");
      setConditionStr("");
      setActionType("run_skill");
      setCooldownValue(0);
      setCooldownUnit("seconds");
      setEnabled(true);
      setSkillName("");
      setPreContext("");
      setTopic("");
      setMessage("");
      setToolName("");
      setToolArgs("{}");
    }
    setConditionError("");
    setTestResult(null);
    setTestEventId("");
    setExecutionsOpen(false);
  };

  useState(() => {
    resetForm(hook);
  });

  const { data: executions } = useQuery<{ executions: HookExecution[] }, Error, HookExecution[]>({
    queryKey: ["/api/hooks", hook?.id, "executions"],
    enabled: !!hook?.id && executionsOpen,
    select: (data) => data.executions,
  });

  const saveMutation = useMutation({
    mutationFn: async (data: any) => {
      if (isCreate) {
        return apiRequest("POST", "/api/hooks", data);
      } else {
        return apiRequest("PUT", `/api/hooks/${hook!.id}`, data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/hooks"] });
      toast({ title: isCreate ? "Hook created" : "Hook updated" });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("DELETE", `/api/hooks/${hook!.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/hooks"] });
      toast({ title: "Hook deleted" });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/hooks/${hook!.id}/test`, { eventId: testEventId ? Number(testEventId) : undefined });
      return res.json();
    },
    onSuccess: (data: any) => {
      setTestResult(data);
    },
    onError: (err: Error) => {
      toast({ title: "Test failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    let condition = null;
    if (conditionStr.trim()) {
      try {
        condition = JSON.parse(conditionStr);
      } catch {
        setConditionError("Invalid JSON");
        return;
      }
    }

    let cooldownSeconds = cooldownValue;
    if (cooldownUnit === "minutes") cooldownSeconds = cooldownValue * 60;
    if (cooldownUnit === "hours") cooldownSeconds = cooldownValue * 3600;

    let actionConfig: any = {};
    if (actionType === "run_skill") {
      actionConfig = { skillName, preContext: preContext || undefined };
    } else if (actionType === "initiate_conversation") {
      actionConfig = { topic, message };
    } else if (actionType === "tool_call") {
      let args = {};
      try {
        args = JSON.parse(toolArgs);
      } catch {
        toast({ title: "Invalid tool arguments JSON", variant: "destructive" });
        return;
      }
      actionConfig = { toolName, arguments: args };
    }

    saveMutation.mutate({
      name,
      description: description || null,
      eventPattern,
      condition,
      actionType,
      actionConfig,
      cooldownSeconds,
      enabled,
    });
  };

  const handleEventPatternChange = (val: string) => {
    setEventPattern(val);
    if (val.length > 0) {
      const filtered = ALL_EVENT_NAMES.filter((n) =>
        n.toLowerCase().includes(val.toLowerCase())
      ).slice(0, 8);
      setEventPatternSuggestions(filtered);
      setShowSuggestions(filtered.length > 0);
    } else {
      setShowSuggestions(false);
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); else resetForm(hook); }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto" data-testid="drawer-hook-detail">
          <SheetHeader>
            <SheetTitle data-testid="text-drawer-title">{isCreate ? "Create Hook" : "Edit Hook"}</SheetTitle>
            <SheetDescription>
              {isCreate
                ? "Configure a new reactive hook that fires when matching events occur."
                : `Editing hook "${hook?.name}"`}
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-4 mt-6">
            <div>
              <Label htmlFor="hook-name">Name *</Label>
              <Input
                id="hook-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Score completed skills"
                data-testid="input-hook-name"
              />
            </div>

            <div>
              <Label htmlFor="hook-description">Description</Label>
              <Textarea
                id="hook-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this hook does..."
                className="h-16"
                data-testid="input-hook-description"
              />
            </div>

            <div className="relative">
              <Label htmlFor="hook-event-pattern">Event Pattern *</Label>
              <Input
                id="hook-event-pattern"
                value={eventPattern}
                onChange={(e) => handleEventPatternChange(e.target.value)}
                onFocus={() => eventPattern && handleEventPatternChange(eventPattern)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                placeholder="e.g., chat.autonomous.* or agent.run.complete"
                className="font-mono text-sm"
                data-testid="input-hook-event-pattern"
              />
              {showSuggestions && (
                <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-md max-h-40 overflow-y-auto">
                  {eventPatternSuggestions.map((s) => (
                    <button
                      key={s}
                      className="w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-muted/50"
                      onMouseDown={() => {
                        setEventPattern(s);
                        setShowSuggestions(false);
                      }}
                      data-testid={`suggestion-${s}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Supports wildcards: * matches any characters (e.g., chat.* matches chat.stream)
              </p>
            </div>

            <div>
              <Label htmlFor="hook-condition">Condition (optional JSON)</Label>
              <Textarea
                id="hook-condition"
                value={conditionStr}
                onChange={(e) => {
                  setConditionStr(e.target.value);
                  setConditionError("");
                }}
                onBlur={() => {
                  if (conditionStr.trim()) {
                    try {
                      JSON.parse(conditionStr);
                      setConditionError("");
                    } catch {
                      setConditionError("Invalid JSON");
                    }
                  }
                }}
                placeholder='{"skillName": "triage"}'
                className="font-mono text-sm h-20"
                data-testid="input-hook-condition"
              />
              {conditionError && (
                <p className="text-xs text-error mt-1" data-testid="text-condition-error">{conditionError}</p>
              )}
            </div>

            <div>
              <Label>Action Type *</Label>
              <RadioGroup value={actionType} onValueChange={setActionType} className="mt-2" data-testid="radio-action-type">
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="run_skill" id="action-run-skill" />
                  <Label htmlFor="action-run-skill" className="text-sm font-normal cursor-pointer">Run Skill</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="initiate_conversation" id="action-initiate-conversation" />
                  <Label htmlFor="action-initiate-conversation" className="text-sm font-normal cursor-pointer">Initiate Conversation</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="tool_call" id="action-tool-call" />
                  <Label htmlFor="action-tool-call" className="text-sm font-normal cursor-pointer">Tool Call</Label>
                </div>
              </RadioGroup>
            </div>

            {actionType === "run_skill" && (
              <div className="space-y-3 pl-2 border-l-2 border-primary/20">
                <div>
                  <Label htmlFor="skill-name">Skill Name</Label>
                  <Input
                    id="skill-name"
                    value={skillName}
                    onChange={(e) => setSkillName(e.target.value)}
                    placeholder="e.g., triage"
                    data-testid="input-skill-name"
                  />
                </div>
                <div>
                  <Label htmlFor="pre-context">Pre-Context</Label>
                  <Textarea
                    id="pre-context"
                    value={preContext}
                    onChange={(e) => setPreContext(e.target.value)}
                    placeholder="Context passed to skill. Use {{payload.field}} for interpolation"
                    className="h-20 text-sm"
                    data-testid="input-pre-context"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Supports {"{{payload.field}}"} template interpolation
                  </p>
                </div>
              </div>
            )}

            {actionType === "initiate_conversation" && (
              <div className="space-y-3 pl-2 border-l-2 border-primary/20">
                <div>
                  <Label htmlFor="conv-topic">Topic</Label>
                  <Input
                    id="conv-topic"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="Conversation topic. Use {{payload.field}} for interpolation"
                    data-testid="input-conv-topic"
                  />
                </div>
                <div>
                  <Label htmlFor="conv-message">Message</Label>
                  <Textarea
                    id="conv-message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Initial message. Use {{payload.field}} for interpolation"
                    className="h-20 text-sm"
                    data-testid="input-conv-message"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Supports {"{{payload.field}}"} template interpolation
                  </p>
                </div>
              </div>
            )}

            {actionType === "tool_call" && (
              <div className="space-y-3 pl-2 border-l-2 border-primary/20">
                <div>
                  <Label htmlFor="tool-name">Tool Name</Label>
                  <Input
                    id="tool-name"
                    value={toolName}
                    onChange={(e) => setToolName(e.target.value)}
                    placeholder="e.g., memory_search"
                    data-testid="input-tool-name"
                  />
                </div>
                <div>
                  <Label htmlFor="tool-args">Arguments (JSON)</Label>
                  <Textarea
                    id="tool-args"
                    value={toolArgs}
                    onChange={(e) => setToolArgs(e.target.value)}
                    placeholder='{"query": "{{payload.query}}"}'
                    className="font-mono text-sm h-20"
                    data-testid="input-tool-args"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Supports {"{{payload.field}}"} template interpolation
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-center gap-4">
              <div className="flex-1">
                <Label htmlFor="cooldown-value">Cooldown</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    id="cooldown-value"
                    type="number"
                    min={0}
                    value={cooldownValue}
                    onChange={(e) => setCooldownValue(Number(e.target.value))}
                    className="w-20"
                    data-testid="input-cooldown-value"
                  />
                  <Select value={cooldownUnit} onValueChange={setCooldownUnit}>
                    <SelectTrigger className="w-[110px]" data-testid="select-cooldown-unit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="seconds">seconds</SelectItem>
                      <SelectItem value="minutes">minutes</SelectItem>
                      <SelectItem value="hours">hours</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label htmlFor="hook-enabled">Enabled</Label>
                <div className="mt-2">
                  <Switch
                    id="hook-enabled"
                    checked={enabled}
                    onCheckedChange={setEnabled}
                    data-testid="switch-hook-enabled"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-4 border-t">
              <Button
                onClick={handleSave}
                disabled={!name || !eventPattern || saveMutation.isPending}
                data-testid="button-save-hook"
              >
                {saveMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                {isCreate ? "Create Hook" : "Save Changes"}
              </Button>
              {!isCreate && (
                <Button
                  variant="destructive"
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={deleteMutation.isPending}
                  data-testid="button-delete-hook"
                >
                  Delete
                </Button>
              )}
            </div>

            {!isCreate && (
              <>
                <div className="border-t pt-4">
                  <Collapsible open={executionsOpen} onOpenChange={setExecutionsOpen}>
                    <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium w-full" data-testid="button-toggle-executions">
                      {executionsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      Recent Executions
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-2 border rounded-md max-h-64 overflow-y-auto">
                        {executions && executions.length > 0 ? (
                          executions.map((exec) => (
                            <ExecutionRow key={exec.id} execution={exec} />
                          ))
                        ) : (
                          <p className="text-xs text-muted-foreground p-3">
                            No executions recorded yet.
                          </p>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>

                <div className="border-t pt-4">
                  <Label className="text-sm font-medium">Test Hook (Dry Run)</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Pick a recent event ID to test this hook against without executing the action.
                  </p>
                  <div className="flex items-center gap-2">
                    <Input
                      value={testEventId}
                      onChange={(e) => setTestEventId(e.target.value)}
                      placeholder="Event DB ID (optional)"
                      className="flex-1"
                      data-testid="input-test-event-id"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => testMutation.mutate()}
                      disabled={testMutation.isPending}
                      data-testid="button-test-hook"
                    >
                      {testMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      Test
                    </Button>
                  </div>
                  {testResult && (
                    <div className="mt-2">
                      <Badge variant={testResult.matched ? "default" : "secondary"} className="mb-2" data-testid="badge-test-result">
                        {testResult.matched ? "Would fire" : "Would not fire"}
                      </Badge>
                      {testResult.resolvedConfig && (
                        <pre className="text-xs text-muted-foreground/80 bg-muted/50 rounded-md p-2 overflow-x-auto max-h-32 overflow-y-auto" data-testid="text-test-resolved-config">
                          {JSON.stringify(testResult.resolvedConfig, null, 2)}
                        </pre>
                      )}
                      {testResult.reason && (
                        <p className="text-xs text-muted-foreground mt-1" data-testid="text-test-reason">{testResult.reason}</p>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent data-testid="dialog-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Hook</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{hook?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function HooksPage({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Hooks", skip: !!embedded });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedHook, setSelectedHook] = useState<Hook | null>(null);

  const { data: hooks, isLoading } = useQuery<{ hooks: Hook[] }, Error, Hook[]>({
    queryKey: ["/api/hooks"],
    select: (data) => data.hooks,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: number; enabled: boolean }) => {
      return apiRequest("PUT", `/api/hooks/${id}`, { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/hooks"] });
    },
  });

  const cardDeleteMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/hooks/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/hooks"] });
    },
  });

  const handleCreateNew = () => {
    setSelectedHook(null);
    setDrawerOpen(true);
  };

  const handleSelectHook = (hook: Hook) => {
    setSelectedHook(hook);
    setDrawerOpen(true);
  };

  const handleCloseDrawer = () => {
    setDrawerOpen(false);
    setSelectedHook(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <span className="text-xs text-muted-foreground" data-testid="text-hooks-count">
          {hooks?.length || 0} hook{(hooks?.length || 0) !== 1 ? "s" : ""}
        </span>
        <Button size="sm" onClick={handleCreateNew} data-testid="button-create-hook">
          <Plus className="h-3.5 w-3.5 mr-1" />
          Create Hook
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {(!hooks || hooks.length === 0) ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-hooks-zero-state">
            No hooks yet.
          </div>
        ) : (
          hooks.map((hook) => (
            <HookCard
              key={hook.id}
              hook={hook}
              onSelect={() => handleSelectHook(hook)}
              onToggle={(enabled) => toggleMutation.mutate({ id: hook.id, enabled })}
              onDelete={() => cardDeleteMutation.mutate(hook.id)}
            />
          ))
        )}
      </div>

      <HookDetailDrawer
        hook={selectedHook}
        open={drawerOpen}
        onClose={handleCloseDrawer}
      />
    </div>
  );
}
