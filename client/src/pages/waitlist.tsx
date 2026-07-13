import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";

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
  ["possible", "Possibly, if the experience proves valuable"],
  ["lower_cost", "I’d prefer a lower-cost plan later"],
  ["curious", "I’m mainly curious"],
] as const;

interface WaitlistResult {
  result: "created" | "existing";
  application: { id: string; email: string; position: number; status: string };
}

function Option({ selected, children, onClick }: { selected: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex min-h-14 w-full items-center justify-between rounded-lg border px-4 py-3 text-left text-[15px] transition-colors", selected ? "border-white bg-white text-black" : "border-white/15 bg-white/[0.03] text-white hover:border-white/35 hover:bg-white/[0.06]")}>
      <span>{children}</span>{selected ? <Check className="h-4 w-4" /> : null}
    </button>
  );
}

export default function WaitlistPage() {
  const [step, setStep] = useState(0);
  const [role, setRole] = useState("");
  const [selectedNeeds, setSelectedNeeds] = useState<string[]>([]);
  const [commercialReadiness, setCommercialReadiness] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [consent, setConsent] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<WaitlistResult | null>(null);

  const canContinue = step === 0 ? !!role : step === 1 ? selectedNeeds.length > 0 : step === 2 ? !!commercialReadiness : /^\S+@\S+\.\S+$/.test(email) && consent;
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

  async function submit() {
    setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/public/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role, needs: selectedNeeds, readiness: commercialReadiness, attribution, consent, website }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "We couldn’t save your place.");
      setResult(payload);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (submissionError) {
      log.error("Waitlist submission failed", submissionError);
      setError(submissionError instanceof Error ? submissionError.message : "We couldn’t save your place.");
    } finally { setSubmitting(false); }
  }

  function toggleNeed(value: string) {
    setSelectedNeeds((current) => current.includes(value) ? current.filter((item) => item !== value) : current.length < 3 ? [...current, value] : current);
  }

  const prompts = [
    ["Which best describes you?", "This helps us understand who Mantra can serve first."],
    ["Where would better support make the biggest difference?", "Choose up to three."],
    ["Would early access fit?", "Early Mantra memberships include a personalized setup fee and cost $500/month."],
    ["Where should we send your invitation?", "We’ll only use this to contact you about Mantra."],
  ];

  return (
    <main className="min-h-[100dvh] bg-[#080808] text-white selection:bg-white selection:text-black">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col px-5 py-6 sm:px-8 sm:py-10">
        <header className="flex items-center justify-between"><span className="text-sm font-semibold tracking-[0.2em]">MANTRA</span>{!result ? <span className="text-xs tabular-nums text-white/45">{step + 1} / 4</span> : null}</header>
        <section className="flex flex-1 flex-col justify-center py-12">
          {result ? (
            <div className="max-w-xl">
              <p className="mb-5 text-xs font-semibold uppercase tracking-[0.18em] text-white/45">You’re in</p>
              <h1 className="text-balance text-5xl font-medium leading-[0.98] tracking-[-0.045em] sm:text-7xl">You’re #{result.application.position}.</h1>
              <p className="mt-7 max-w-lg text-lg leading-8 text-white/65">You’re on the Mantra waitlist. We’re opening in small groups, prioritizing the people for whom Mantra can create the most value today.</p>
              <p className="mt-5 text-sm leading-6 text-white/45">{result.result === "created" ? `We sent confirmation to ${result.application.email}.` : `You were already on the list at this position.`}</p>
            </div>
          ) : (
            <div>
              <p className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-white/45">Join the waitlist</p>
              <h1 className="max-w-xl text-balance text-4xl font-medium leading-[1.02] tracking-[-0.04em] sm:text-6xl">{prompts[step][0]}</h1>
              <p className="mt-4 max-w-lg text-base leading-7 text-white/55">{prompts[step][1]}</p>
              <div className="mt-9 grid gap-2 sm:grid-cols-2">
                {step === 0 ? roles.map(([value, label]) => <Option key={value} selected={role === value} onClick={() => setRole(value)}>{label}</Option>) : null}
                {step === 1 ? needs.map(([value, label]) => <Option key={value} selected={selectedNeeds.includes(value)} onClick={() => toggleNeed(value)}>{label}</Option>) : null}
                {step === 2 ? <div className="sm:col-span-2 grid gap-2">{readiness.map(([value, label]) => <Option key={value} selected={commercialReadiness === value} onClick={() => setCommercialReadiness(value)}>{label}</Option>)}</div> : null}
                {step === 3 ? <div className="sm:col-span-2 space-y-4"><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoFocus className="h-14 border-white/20 bg-white/[0.04] px-4 text-base text-white placeholder:text-white/30 focus-visible:ring-white" /><input aria-hidden="true" tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} className="absolute -left-[9999px]" /><label className="flex items-start gap-3 text-sm leading-6 text-white/50"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1 accent-white" /><span>I agree to receive email about my Mantra waitlist status and invitation.</span></label></div> : null}
              </div>
              {error ? <p className="mt-5 text-sm text-red-400">{error}</p> : null}
              <div className="mt-8 flex items-center justify-between">
                <Button variant="ghost" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || submitting} className="px-0 text-white/55 hover:bg-transparent hover:text-white"><ArrowLeft className="mr-2 h-4 w-4" />Back</Button>
                <Button onClick={() => step === 3 ? void submit() : setStep((current) => current + 1)} disabled={!canContinue || submitting} className="h-12 rounded-md bg-white px-5 text-black hover:bg-white/90">{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : step === 3 ? "Join the waitlist" : <>Continue<ArrowRight className="ml-2 h-4 w-4" /></>}</Button>
              </div>
            </div>
          )}
        </section>
        <footer className="text-xs leading-5 text-white/30">Personal intelligence for ambitious, complex lives.</footer>
      </div>
    </main>
  );
}
