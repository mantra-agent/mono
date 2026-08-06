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
 *      have to retry. Without this they'd save, see "ok", and then
 *      hit prod 401s for minutes — exactly the failure mode
 *      task-945 was diagnosing.
 *
 * The underlying state model is identical to `SecretControl`
 * (metadata fetch, set/clear mutations) — we duplicate it rather
 * than overload `SecretControl` with render-prop hooks because the
 * extras are V3-webhook-specific and unlikely to apply to any other
 * secret in the catalog.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, Sparkles, CheckCircle2, AlertCircle } from "lucide-react";
import { useIsAdmin } from "@/components/SecretControl";
import type { SecretMetadata } from "@shared/secrets-catalog";

const SECRET_NAME = "VOICE_V3_WEBHOOK_SECRET";

/** 32 bytes (64 hex chars) ≈ 256 bits of entropy — overkill but cheap. */
function generateStrongRandom(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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
      setEditing(false);
      setValue("");
      setShowValue(false);
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
      toast({ title: "Webhook secret cleared", description: describeReprovision(resp.reprovision) });
    },
    onError: (err: Error) => {
      toast({ title: "Clear failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading || !meta) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="secret-loading-voice-webhook">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading webhook secret…
      </div>
    );
  }

  const statusBadge = (() => {
    if (meta.status === "invalid") return <Badge variant="destructive" data-testid="badge-secret-status-voice-webhook">Invalid</Badge>;
    if (meta.status === "set") return <Badge variant="default" data-testid="badge-secret-status-voice-webhook">Set</Badge>;
    return <Badge variant="outline" data-testid="badge-secret-status-voice-webhook">Not set</Badge>;
  })();
  const sourceHint = meta.status === "set" ? (meta.source === "db" ? "app" : "host env") : null;

  return (
    <div className="space-y-2 p-3 rounded-md border bg-muted/20" data-testid="card-voice-v3-webhook-secret">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium" data-testid="text-secret-label-voice-webhook">{meta.label}</span>
        {statusBadge}
        {sourceHint && (
          <span className="text-xs text-muted-foreground" data-testid="text-secret-source-voice-webhook">via {sourceHint}</span>
        )}
        {meta.last4 && (
          <span className="text-xs text-muted-foreground font-mono" data-testid="text-secret-last4-voice-webhook">
            ••••{meta.last4}
          </span>
        )}
        {meta.updatedAt && (
          <span className="text-xs text-muted-foreground" data-testid="text-secret-updated-voice-webhook">
            updated {new Date(meta.updatedAt).toLocaleDateString()}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Shared secret ElevenLabs sends with every V3 tool webhook call. Saving here also re-PATCHes the EL agent so the new value goes live without a server restart.
      </p>
      {!isAdmin && (
        <p className="text-xs text-muted-foreground italic">Admin only — sign in as an admin to manage.</p>
      )}
      {isAdmin && !editing && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing(true)}
            data-testid="button-secret-edit-voice-webhook"
          >
            {meta.source === "db" ? "Rotate" : "Set"}
          </Button>
          {meta.source === "db" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (confirm("Clear VOICE_V3_WEBHOOK_SECRET? Reads will fall back to host env (if any), and the EL agent will be re-PATCHed.")) {
                  clearMutation.mutate();
                }
              }}
              disabled={clearMutation.isPending}
              data-testid="button-secret-clear-voice-webhook"
            >
              {clearMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Clear
            </Button>
          )}
        </div>
      )}
      {isAdmin && editing && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              type={showValue ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Paste a value or click Generate"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
              data-testid="input-secret-voice-webhook"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setShowValue((s) => !s)}
              data-testid="button-secret-toggle-voice-webhook"
            >
              {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (!value.trim()) {
                  toast({ title: "Value required", variant: "destructive" });
                  return;
                }
                setMutation.mutate(value);
              }}
              disabled={setMutation.isPending}
              data-testid="button-secret-save-voice-webhook"
            >
              {setMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Save & re-provision
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const next = generateStrongRandom();
                setValue(next);
                setShowValue(true);
              }}
              data-testid="button-secret-generate-voice-webhook"
            >
              <Sparkles className="h-3 w-3 mr-1" />
              Generate strong random
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { setEditing(false); setValue(""); setShowValue(false); }}
              data-testid="button-secret-cancel-voice-webhook"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {lastReprovision && (
        <ReprovisionBanner info={lastReprovision} />
      )}
    </div>
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
