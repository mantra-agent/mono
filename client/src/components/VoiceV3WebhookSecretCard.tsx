/**
 * Dedicated UI for the V3 webhook secret.
 *
 * Why not just `<SecretControl name="VOICE_V3_WEBHOOK_SECRET" />`?
 *
 * Two extras live here that aren't useful for any other secret:
 *
 *   1. "Generate strong random" — the V3 webhook secret is a shared
 *      symmetric token between this server (authorize()) and the
 *      ElevenLabs workspace tools (request_headers["X-Voice-Webhook-Secret"]).
 *      Nothing in EL ever needs to read it back, so the right hygiene
 *      is "high-entropy random, rotate on suspicion". Asking the
 *      operator to invent one invites short/weak values; an in-page
 *      generator removes that footgun.
 *
 *   2. Re-provision feedback — `POST /api/secrets/set` for this
 *      particular name triggers a server-side EL agent re-PATCH so
 *      the workspace tools start sending the new header on the next
 *      tool call. The route returns a `reprovision` field describing
 *      that side-effect; we surface it inline so the operator knows
 *      whether the new secret is actually live in EL or whether they
 *      have to retry.
 *
 * Visually this matches the other secret rows on the Secrets page
 * (ProfileTreeRow + hover menu + inline editor). The extras live in
 * the editor and a thin banner under the row.
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { useToast } from "@/hooks/use-toast";
import { useIsAdmin } from "@/components/SecretControl";
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Sparkles } from "lucide-react";
import type { SecretMetadata } from "@shared/secrets-catalog";

const SECRET_NAME = "VOICE_V3_WEBHOOK_SECRET";

interface ReprovisionInfo {
  result: "ok" | "skipped" | "error";
  engine?: "v2" | "v3";
  reason?: string;
  error?: string;
}

interface SetSecretResponse {
  ok: true;
  reprovision?: ReprovisionInfo;
}

function generateStrongRandom(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function VoiceV3WebhookSecretCard() {
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [lastReprovision, setLastReprovision] = useState<ReprovisionInfo | null>(null);

  const { data, isLoading } = useQuery<{ secrets: SecretMetadata[] }>({
    queryKey: ["/api/secrets/metadata"],
  });
  const meta = data?.secrets.find((s) => s.name === SECRET_NAME);

  const setMutation = useMutation({
    mutationFn: async (newValue: string) => {
      const res = await apiRequest("POST", "/api/secrets/set", { name: SECRET_NAME, value: newValue });
      return (await res.json()) as SetSecretResponse;
    },
    onSuccess: (resp) => {
      queryClient.invalidateQueries({ queryKey: ["/api/secrets/metadata"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      setLastReprovision(resp.reprovision ?? null);
      toast({ title: "Webhook secret saved", description: describeReprovision(resp.reprovision) });
      closeEditor();
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/secrets/clear", { name: SECRET_NAME });
      return (await res.json()) as { ok: true; removed: boolean; reprovision?: ReprovisionInfo };
    },
    onSuccess: (resp) => {
      queryClient.invalidateQueries({ queryKey: ["/api/secrets/metadata"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      setLastReprovision(resp.reprovision ?? null);
      toast({
        title: "Webhook secret cleared",
        description: resp.removed
          ? describeReprovision(resp.reprovision)
          : "No DB value to clear; host env (if any) still applies.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Clear failed", description: err.message, variant: "destructive" });
    },
  });

  function closeEditor() {
    setEditing(false);
    setValue("");
    setShowValue(false);
  }

  function openEditor() {
    if (!isAdmin) return;
    setEditing(true);
    setShowValue(false);
    setValue("");
  }

  function save() {
    if (!value.trim()) {
      toast({ title: "Value required", variant: "destructive" });
      return;
    }
    setMutation.mutate(value.trim());
  }

  if (isLoading || !meta) {
    return (
      <ProfileTreeRow
        label="Voice V3 Webhook Secret"
        icon={<KeyRound className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        wideLabel
        testId="secret-loading-voice-webhook"
      >
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      </ProfileTreeRow>
    );
  }

  const status = (() => {
    if (meta.status === "invalid") {
      return <span className="text-xs text-destructive" data-testid="text-secret-status-voice-webhook">Invalid</span>;
    }
    if (meta.status === "set") {
      return (
        <span className="flex items-center gap-1.5" data-testid="text-secret-status-voice-webhook">
          {meta.last4
            ? <span className="font-mono text-xs text-muted-foreground">••••{meta.last4}</span>
            : <span className="text-xs text-muted-foreground">Set</span>}
          {meta.source !== "db" && <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">env</span>}
        </span>
      );
    }
    return <span className="text-xs text-muted-foreground/60" data-testid="text-secret-status-voice-webhook">Not set</span>;
  })();

  const menuContent = isAdmin ? (
    <>
      <DropdownMenuItem onClick={openEditor} data-testid="button-secret-edit-voice-webhook">
        {meta.source === "db" ? "Rotate" : "Set"}
      </DropdownMenuItem>
      {meta.source === "db" && (
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => {
            if (confirm("Clear VOICE_V3_WEBHOOK_SECRET? Reads will fall back to host env (if any), and the EL agent will be re-PATCHed.")) {
              clearMutation.mutate();
            }
          }}
          data-testid="button-secret-clear-voice-webhook"
        >
          Clear
        </DropdownMenuItem>
      )}
    </>
  ) : undefined;

  return (
    <>
      <ProfileTreeRow
        label={meta.label}
        icon={<KeyRound className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        wideLabel
        menuContent={menuContent}
        menuVisibility="hover"
        testId="secret-control-voice-webhook"
        expandedContent={
          <p className="text-muted-foreground">
            Shared secret ElevenLabs sends with every V3 tool webhook call. Saving here also re-PATCHes the EL agent so the new value goes live without a server restart.
          </p>
        }
      >
        {isAdmin ? (
          <button
            type="button"
            className="max-w-full truncate text-left text-xs leading-relaxed text-inherit hover:text-foreground"
            onClick={openEditor}
            data-testid="button-secret-status-voice-webhook"
          >
            {status}
          </button>
        ) : (
          status
        )}
      </ProfileTreeRow>
      {isAdmin && editing && (
        <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2 pl-8" data-testid="secret-editor-voice-webhook">
          <Input
            type={showValue ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste or generate a high-entropy secret"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            className="h-6 min-w-[12rem] flex-1 bg-muted/50 px-1.5 py-0 font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); save(); }
              else if (e.key === "Escape") { e.preventDefault(); closeEditor(); }
            }}
            data-testid="input-secret-voice-webhook"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground/70"
            onClick={() => setShowValue((s) => !s)}
            aria-label={showValue ? "Hide value" : "Show value"}
            data-testid="button-secret-toggle-voice-webhook"
          >
            {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              setValue(generateStrongRandom());
              setShowValue(true);
            }}
            data-testid="button-secret-generate-voice-webhook"
          >
            <Sparkles className="mr-1 h-3 w-3" />
            Generate
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={save}
            disabled={setMutation.isPending}
            data-testid="button-secret-save-voice-webhook"
          >
            {setMutation.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={closeEditor}
            data-testid="button-secret-cancel-voice-webhook"
          >
            Cancel
          </Button>
        </div>
      )}
      {lastReprovision && (
        <div className="px-2 pb-2 pl-8">
          <ReprovisionBanner info={lastReprovision} />
        </div>
      )}
    </>
  );
}

function describeReprovision(info: ReprovisionInfo | undefined): string {
  if (!info) return "Saved.";
  if (info.result === "ok") return "Saved and ElevenLabs agent re-PATCHed.";
  if (info.result === "skipped") {
    if (info.reason === "engine_not_v3") return "Saved. Engine isn't V3, so EL agent re-PATCH was skipped.";
    if (info.reason === "no_agent_configured") return "Saved. No ELEVENLABS_AGENT_ID configured, so EL re-PATCH was skipped.";
    return "Saved. EL re-PATCH skipped.";
  }
  return `Saved, but EL re-PATCH failed: ${info.error ?? "unknown error"}`;
}

function ReprovisionBanner({ info }: { info: ReprovisionInfo }) {
  if (info.result === "ok") {
    return (
      <div className="flex items-center gap-2 text-xs text-success-foreground" data-testid="text-reprovision-result-ok">
        <CheckCircle2 className="h-3 w-3" />
        ElevenLabs agent re-provisioned ({info.engine ?? "v3"}). New header live on next tool call.
      </div>
    );
  }
  if (info.result === "skipped") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="text-reprovision-result-skipped">
        <AlertCircle className="h-3 w-3" />
        EL re-provision skipped: {info.reason ?? "unknown"}
        {info.engine ? ` (engine=${info.engine})` : ""}.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-destructive" data-testid="text-reprovision-result-error">
      <AlertCircle className="h-3 w-3" />
      EL re-provision failed: {info.error ?? "unknown error"}
    </div>
  );
}
