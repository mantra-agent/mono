import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MantraLogo } from "@/components/mantra-logo";
import { createLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import {
  authButtonClass,
  authFormClass,
  authInputClass,
  authLinkClass,
  authLogoClass,
  authShellClass,
  authTitleClass,
} from "@/lib/auth-layout";

const log = createLogger("WaitlistPage");

const roles = [
  ["founder", "Founder or business owner"],
  ["executive", "Executive or operator"],
  ["investor", "Investor"],
  ["coach", "Coach or advisor"],
  ["creator", "Creator"],
  ["other", "Something else"],
] as const;

const needs = [
  ["priorities", "Priorities and follow-through"],
  ["work", "Work and projects"],
  ["relationships", "Relationships and communication"],
  ["decisions", "Decisions and knowledge"],
  ["health", "Health and energy"],
  ["money", "Money and planning"],
  ["connection", "Keeping everything connected"],
] as const;

const readiness = [
  ["ready", "I’m ready to explore that now"],
  ["possible", "Possibly, if it proves valuable"],
  ["lower_cost", "I’d prefer a lower-cost plan later"],
  ["curious", "I’m mainly curious"],
] as const;

type WaitlistStep = "role" | "needs" | "readiness" | "email";

const stepOrder: WaitlistStep[] = ["role", "needs", "readiness", "email"];

const stepTitles: Record<WaitlistStep, string> = {
  role: "Which best describes you?",
  needs: "Where would support help most?",
  readiness: "Would early access fit?",
  email: "Where should we reach you?",
};

const stepHints: Record<WaitlistStep, string> = {
  role: "This helps us understand who Mantra can serve first.",
  needs: "Choose up to three.",
  readiness: "Early memberships include a personalized setup fee and cost $500/month.",
  email: "We’ll only use this to contact you about Mantra.",
};

interface WaitlistResult {
  result: "created" | "existing";
  application: { id: string; email: string; position: number; status: string };
}

function OptionButton({ selected, children, onClick }: { selected: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className={cn(
        "h-11 w-full justify-between px-4 text-sm font-normal",
        selected && "border-cta text-foreground",
      )}
    >
      <span className="truncate">{children}</span>
      {selected ? <Check className="h-4 w-4 shrink-0 text-cta" /> : null}
    </Button>
  );
}

export default function WaitlistPage() {
  const [step, setStep] = useState<WaitlistStep>("role");
  const [role, setRole] = useState("");
  const [selectedNeeds, setSelectedNeeds] = useState<string[]>([]);
  const [commercialReadiness, setCommercialReadiness] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [consent, setConsent] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<WaitlistResult | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "email") {
      requestAnimationFrame(() => emailRef.current?.focus({ preventScroll: true }));
    }
  }, [step]);

  const attribution = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      source: params.get("source") || "direct",
      utmSource: params.get("utm_source") || undefined,
      utmMedium: params.get("utm_medium") || undefined,
      utmCampaign: params.get("utm_campaign") || undefined,
      utmContent: params.get("utm_content") || undefined,
      referrer: document.referrer || undefined,
      landingPath: `${window.location.pathname}${window.location.search}`,
    };
  }, []);

  const canContinue =
    step === "role" ? !!role :
    step === "needs" ? selectedNeeds.length > 0 :
    step === "readiness" ? !!commercialReadiness :
    /^\S+@\S+\.\S+$/.test(email) && consent;

  function goBack() {
    const index = stepOrder.indexOf(step);
    if (index > 0) setStep(stepOrder[index - 1]);
  }

  function goNext() {
    const index = stepOrder.indexOf(step);
    if (index < stepOrder.length - 1) setStep(stepOrder[index + 1]);
  }

  function toggleNeed(value: string) {
    setSelectedNeeds((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : current.length < 3
          ? [...current, value]
          : current,
    );
  }

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/public/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role, needs: selectedNeeds, readiness: commercialReadiness, attribution, consent, website }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "We couldn’t save your place.");
      setResult(payload);
    } catch (submissionError) {
      log.error("Waitlist submission failed", submissionError);
      setError(submissionError instanceof Error ? submissionError.message : "We couldn’t save your place.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canContinue || submitting) return;
    if (step === "email") {
      void submit();
    } else {
      goNext();
    }
  }

  return (
    <div className="flex min-h-screen justify-center bg-background p-4 pt-[14vh]">
      <div className={authShellClass}>
        <div className="flex h-24 justify-center">
          <MantraLogo className={authLogoClass} />
        </div>
        {result ? (
          <>
            <h1 className={authTitleClass}>You’re #{result.application.position}</h1>
            <div className="space-y-4 text-center">
              <p className="text-sm text-muted-foreground">
                You’re on the Mantra waitlist. We’re opening in small groups, prioritizing the people for whom Mantra can create the most value today.
              </p>
              <p className="text-sm text-muted-foreground">
                {result.result === "created"
                  ? `We sent confirmation to ${result.application.email}.`
                  : "You were already on the list at this position."}
              </p>
            </div>
          </>
        ) : (
          <>
            <h1 className={authTitleClass}>{stepTitles[step]}</h1>
            <form onSubmit={handleSubmit} className={authFormClass}>
              <div className="space-y-2">
                <p className="text-center text-sm text-muted-foreground">{stepHints[step]}</p>
                {step === "role" ? roles.map(([value, label]) => (
                  <OptionButton key={value} selected={role === value} onClick={() => setRole(value)}>{label}</OptionButton>
                )) : null}
                {step === "needs" ? needs.map(([value, label]) => (
                  <OptionButton key={value} selected={selectedNeeds.includes(value)} onClick={() => toggleNeed(value)}>{label}</OptionButton>
                )) : null}
                {step === "readiness" ? readiness.map(([value, label]) => (
                  <OptionButton key={value} selected={commercialReadiness === value} onClick={() => setCommercialReadiness(value)}>{label}</OptionButton>
                )) : null}
                {step === "email" ? (
                  <>
                    <Input
                      ref={emailRef}
                      id="waitlist-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="Email..."
                      autoComplete="email"
                      required
                      className={authInputClass}
                      data-testid="input-waitlist-email"
                    />
                    <input
                      aria-hidden="true"
                      tabIndex={-1}
                      autoComplete="off"
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                      className="absolute -left-[9999px]"
                    />
                    <label className="flex items-start gap-2 pt-1 text-xs leading-5 text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                        className="mt-0.5 accent-cta"
                      />
                      <span>I agree to receive email about my Mantra waitlist status and invitation.</span>
                    </label>
                  </>
                ) : null}
                {error ? <p className="text-center text-sm text-destructive">{error}</p> : null}
              </div>
              <div className="space-y-4">
                <Button
                  type="submit"
                  className={authButtonClass}
                  disabled={!canContinue || submitting}
                  data-testid="button-waitlist-continue"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : step === "email" ? "Join the waitlist" : "Continue"}
                </Button>
                {step !== "role" ? (
                  <Button
                    type="button"
                    variant="link"
                    className={authLinkClass}
                    onClick={goBack}
                    disabled={submitting}
                    data-testid="button-waitlist-back"
                  >
                    Back
                  </Button>
                ) : null}
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
