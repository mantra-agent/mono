import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";

type Phase = "form" | "saving" | "ready";

const authInputClass = "placeholder:text-muted-foreground/70 placeholder:italic";

interface OnboardingPayload {
  name: string;
}

export default function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [phase, setPhase] = useState<Phase>("form");
  const [name, setName] = useState("");

  useEffect(() => {
    apiRequest("POST", "/api/onboarding/start", {}).catch(() => undefined);
  }, []);

  const complete = useMutation({
    mutationFn: async (payload: OnboardingPayload) => {
      const res = await apiRequest("POST", "/api/onboarding/complete", payload);
      return res.json();
    },
    onMutate: () => setPhase("saving"),
    onSuccess: () => {
      setPhase("ready");
      localStorage.removeItem("xyz_onboarding_complete");
      localStorage.removeItem("onboarding_skipped");
      onComplete();
      void queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
    },
    onError: () => setPhase("form"),
  });

  const canSubmit = name.trim().length > 0;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || complete.isPending) return;
    complete.mutate({ name: name.trim() });
  };

  if (phase === "saving" || phase === "ready") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="flex flex-col items-center justify-center gap-4 py-8">
          {phase === "ready" ? (
            <CheckCircle2 className="h-5 w-5 text-primary" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-1/2 min-w-[180px] max-w-sm">
        <form onSubmit={handleSubmit} className="space-y-4" data-testid="onboarding-ftue-form">
          <div className="space-y-2">
            <Input
              id="onboarding-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name"
              autoComplete="name"
              required
              autoFocus
              className={authInputClass}
              data-testid="input-onboarding-name"
            />
          </div>

          {complete.error && (
            <p className="text-sm text-destructive" data-testid="onboarding-error">
              {complete.error instanceof Error ? complete.error.message : "Onboarding failed"}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={!canSubmit || complete.isPending} data-testid="button-enter-demo">
            Begin
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
