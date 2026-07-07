import { useState, useEffect, useRef } from "react";
import { useLocation, useParams } from "wouter";
import { useRegister } from "@/hooks/use-auth";
import { completeStartupOnboarding } from "@/lib/startup-onboarding";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { CopyableAuthError, type CopyableAuthErrorState } from "@/components/copyable-auth-error";
import { MantraLogo } from "@/components/mantra-logo";
import { authButtonClass, authFormClass, authInputClass, authLinkClass, authLogoClass, authShellClass, authTitleClass } from "@/lib/auth-layout";

type StartupStep = "email" | "password" | "name";

const stepTitles: Record<StartupStep, string> = {
  email: "Create your account",
  password: "",
  name: "What should Agent call you?",
};

export default function RegisterPage() {
  const params = useParams<{ token: string }>();
  const token = params.token || "";
  const isInviteRegistration = !!token;
  const [, setLocation] = useLocation();
  const register = useRegister();

  const [inviteEmail, setInviteEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);

  const [step, setStep] = useState<StartupStep>("email");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [authError, setAuthError] = useState<CopyableAuthErrorState | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    fetch(`/api/auth/invite/${token}`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error("Invalid");
        return res.json();
      })
      .then((data) => {
        setInviteEmail(data.email);
        setLoading(false);
      })
      .catch(() => {
        setInvalid(true);
        setLoading(false);
      });
  }, [token]);

  useEffect(() => {
    if (loading || invalid) return;
    const target = step === "email" ? emailRef : step === "password" ? passwordRef : nameRef;
    requestAnimationFrame(() => target.current?.focus({ preventScroll: true }));
  }, [step, loading, invalid]);

  const handleEmailSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setStep("password");
  };

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setAuthError({ title: "Passwords do not match" });
      return;
    }
    if (password.length < 8) {
      setAuthError({ title: "Password must be at least 8 characters" });
      return;
    }
    register.mutate(
      { email: inviteEmail.trim(), password, inviteToken: token || undefined },
      {
        onSuccess: () => setStep("name"),
        onError: (err: any) => {
          const msg = err.message?.includes("400")
            ? "Invalid registration data"
            : "Registration failed";
          setAuthError({ title: msg, detail: err?.message });
        },
      }
    );
  };

  const handleNameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || savingName) return;
    setSavingName(true);
    try {
      const result = await completeStartupOnboarding(name);
      const params = new URLSearchParams();
      if (result.ftueSessionId) {
        params.set("c", result.ftueSessionId);
        params.set("autoVoice", "1");
      }
      const query = params.toString();
      setLocation(`/session${query ? `?${query}` : ""}`, { replace: true });
    } catch (err: any) {
      setAuthError({ title: err?.message || "Could not save name", detail: err?.message });
      setSavingName(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (invalid) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Invalid invite</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This invite link is invalid or has expired.
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setLocation("/login")}
              data-testid="button-back-to-login"
            >
              Back to login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen justify-center bg-background p-4 pt-[14vh]">
      <div className={authShellClass}>
        <div className="flex h-24 justify-center">
          <MantraLogo className={authLogoClass} />
        </div>
        <h1 className={authTitleClass} aria-hidden={!stepTitles[step]}>{stepTitles[step]}</h1>
        {step === "email" ? (
          <form onSubmit={handleEmailSubmit} className={authFormClass}>
            <div className="space-y-2">
              <Input
                ref={emailRef}
                id="reg-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                disabled={isInviteRegistration}
                className={`${authInputClass}${isInviteRegistration ? " opacity-70" : ""}`}
                placeholder="Email..."
                autoComplete="email"
                required
                data-testid="input-register-email"
              />
            </div>
            <div className="space-y-4">
              <Button type="submit" className={authButtonClass} data-testid="button-register-email-next">
                Continue
              </Button>
              <Button
                type="button"
                variant="link"
                className={authLinkClass}
                onClick={() => setLocation("/login")}
                data-testid="link-register-sign-in"
              >
                Sign in
              </Button>
            </div>
          </form>
        ) : step === "password" ? (
          <form onSubmit={handlePasswordSubmit} className={authFormClass}>
            <div className="space-y-4">
              <div className="space-y-2">
                <Input
                  ref={passwordRef}
                  id="reg-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Choose password..."
                  autoComplete="new-password"
                  required
                  className={authInputClass}
                  data-testid="input-register-password"
                />
              </div>
              <div className="space-y-2">
                <Input
                  id="reg-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Confirm password..."
                  autoComplete="new-password"
                  required
                  className={authInputClass}
                  data-testid="input-register-confirm"
                />
              </div>
            </div>
            <div className="space-y-4">
              <Button
                type="submit"
                className={authButtonClass}
                disabled={register.isPending}
                data-testid="button-register-submit"
              >
                {register.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Continue"
                )}
              </Button>
              <Button
                type="button"
                variant="link"
                className={authLinkClass}
                onClick={() => setStep("email")}
                data-testid="button-register-back"
              >
                Back
              </Button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleNameSubmit} className={authFormClass}>
            <div className="space-y-2">
              <Input
                ref={nameRef}
                id="reg-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                autoComplete="name"
                required
                className={authInputClass}
                data-testid="input-register-name"
              />
            </div>
            <Button
              type="submit"
              className={authButtonClass}
              disabled={savingName || !name.trim()}
              data-testid="button-register-finish"
            >
              {savingName ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Begin"
              )}
            </Button>
          </form>
        )}
      </div>
      <CopyableAuthError error={authError} onDismiss={() => setAuthError(null)} />
    </div>
  );
}
