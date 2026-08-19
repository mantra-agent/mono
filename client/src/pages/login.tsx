import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { useLogin, useSetup, useAuthStatus } from "@/hooks/use-auth";
import {
  completeStartupOnboarding,
  getStartupOnboardingDestination,
} from "@/lib/startup-onboarding";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CopyableAuthError, type CopyableAuthErrorState } from "@/components/copyable-auth-error";
import { MantraLogo } from "@/components/mantra-logo";
import { authButtonClass, authFormClass, authInputClass, authLinkClass, authLogoClass, authShellClass, authTitleClass } from "@/lib/auth-layout";

type SetupStep = "email" | "password" | "name";

const setupStepTitle: Record<SetupStep, string> = {
  email: "Create admin account",
  password: "",
  name: "What should Agent call you?",
};

type AuthErrorState = CopyableAuthErrorState;

interface LoginFormProps {
  initialEmail: string;
  onAuthenticated: () => void;
  onError: (error: AuthErrorState) => void;
}

function LoginForm({ initialEmail, onAuthenticated, onError }: LoginFormProps) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const login = useLogin();

  useEffect(() => {
    emailRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate(
      { email, password },
      {
        onSuccess: onAuthenticated,
        onError: (err: any) => {
          const msg = err.message?.includes("401")
            ? "Invalid email or password"
            : "Login failed";
          onError({ title: msg, detail: err?.message });
        },
      }
    );
  };

  return (
    <form onSubmit={handleSubmit} className={authFormClass}>
      <div className="space-y-4">
        <div className="space-y-2">
          <Input
            ref={emailRef}
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email..."
            autoComplete="email"
            required
            className={authInputClass}
            data-testid="input-login-email"
          />
        </div>
        <div className="space-y-2">
          <Input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password..."
            autoComplete="current-password"
            required
            className={authInputClass}
            data-testid="input-login-password"
          />
        </div>
      </div>
      <div className="space-y-4">
        <Button
          type="submit"
          className={authButtonClass}
          disabled={login.isPending}
          data-testid="button-login-submit"
        >
          {login.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Sign in"
          )}
        </Button>
        <p className="text-center text-sm">
          <Link
            href="/forgot-password"
            className={authLinkClass}
            data-testid="link-forgot-password"
          >
            Forgot password
          </Link>
        </p>
        <p className="text-center text-sm">
          <Link
            href="/register"
            className={authLinkClass}
            data-testid="link-create-account"
          >
            Create account
          </Link>
        </p>
      </div>
    </form>
  );
}

function SetupForm({ onStepChange, onError }: { onStepChange: (step: SetupStep) => void; onError: (error: AuthErrorState) => void }) {
  const [, setLocation] = useLocation();
  const [step, setStepState] = useState<SetupStep>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const setup = useSetup();

  useEffect(() => {
    const target = step === "email" ? emailRef : step === "password" ? passwordRef : nameRef;
    requestAnimationFrame(() => target.current?.focus({ preventScroll: true }));
  }, [step]);

  const setStep = (next: SetupStep) => {
    setStepState(next);
    onStepChange(next);
  };

  const handleEmailSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStep("password");
  };

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      onError({ title: "Passwords do not match" });
      return;
    }
    if (password.length < 8) {
      onError({ title: "Password must be at least 8 characters" });
      return;
    }
    setStep("name");
  };

  const handleNameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || savingName) return;
    setSavingName(true);
    try {
      await setup.mutateAsync({ email: email.trim(), password, name: name.trim() });
      const result = await completeStartupOnboarding(name);
      setLocation(getStartupOnboardingDestination(result), { replace: true });
    } catch (err: any) {
      onError({
        title: err.message?.includes("400") ? "Invalid setup data" : err?.message || "Setup failed",
        detail: err?.message,
      });
      setSavingName(false);
    }
  };

  if (step === "email") {
    return (
      <form onSubmit={handleEmailSubmit} className={authFormClass}>
        <div className="space-y-2">
          <Input
            ref={emailRef}
            id="setup-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email..."
            autoComplete="email"
            required
            className={authInputClass}
            data-testid="input-setup-email"
          />
        </div>
        <Button type="submit" className={authButtonClass} data-testid="button-setup-email-next">
          Continue
        </Button>
      </form>
    );
  }

  if (step === "password") {
    return (
      <form onSubmit={handlePasswordSubmit} className={authFormClass}>
        <div className="space-y-4">
          <div className="space-y-2">
            <Input
              ref={passwordRef}
              id="setup-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Choose password..."
              autoComplete="new-password"
              required
              className={authInputClass}
              data-testid="input-setup-password"
            />
          </div>
          <div className="space-y-2">
            <Input
              id="setup-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm password..."
              autoComplete="new-password"
              required
              className={authInputClass}
              data-testid="input-setup-confirm"
            />
          </div>
        </div>
        <div className="space-y-4">
          <Button
            type="submit"
            className={authButtonClass}
            data-testid="button-setup-submit"
          >
            Continue
          </Button>
          <Button
            type="button"
            variant="link"
            className={authLinkClass}
            onClick={() => setStep("email")}
            data-testid="button-setup-back"
          >
            Back
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleNameSubmit} className={authFormClass}>
      <div className="space-y-2">
        <Input
          ref={nameRef}
          id="setup-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          autoComplete="name"
          required
          className={authInputClass}
          data-testid="input-setup-name"
        />
      </div>
      <Button
        type="submit"
        className={authButtonClass}
        disabled={savingName || !name.trim()}
        data-testid="button-setup-finish"
      >
        {savingName ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          "Begin"
        )}
      </Button>
    </form>
  );
}

export interface LoginPageProps {
  initialEmail?: string;
  returnTo?: string;
}

function safeReturnTo(value: string | undefined): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/home";
}

export default function LoginPage({ initialEmail, returnTo }: LoginPageProps) {
  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const resolvedInitialEmail = initialEmail ?? fragment.get("email") ?? query.get("email") ?? "";
  const resolvedReturnTo = returnTo ?? fragment.get("returnTo") ?? query.get("returnTo") ?? undefined;
  const { data: authStatus, isLoading } = useAuthStatus();
  const [, setLocation] = useLocation();
  const devLoginAttempted = useRef(false);
  const [setupStep, setSetupStep] = useState<SetupStep>("email");
  const [authError, setAuthError] = useState<AuthErrorState | null>(null);

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV && authStatus?.setupComplete && !devLoginAttempted.current) {
      devLoginAttempted.current = true;
      apiRequest("POST", "/api/auth/dev-login")
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
          queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
          setLocation("/home");
        })
        .catch(() => {});
    }
  }, [authStatus, setLocation]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (import.meta.env.DEV && authStatus?.setupComplete) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const needsSetup = !authStatus?.setupComplete;
  const handleAuthenticated = () => {
    const target = safeReturnTo(resolvedReturnTo);
    if (target.startsWith("/r/")) {
      window.location.replace(target);
      return;
    }
    setLocation(target, { replace: true });
  };

  return (
    <div className="flex min-h-screen justify-center bg-background p-4 pt-[14vh]">
      <div className={authShellClass}>
        <div className="flex h-24 justify-center">
          <MantraLogo className={authLogoClass} />
        </div>
        <h1 className={authTitleClass} aria-hidden={!needsSetup || !setupStepTitle[setupStep]}>
          {needsSetup ? setupStepTitle[setupStep] : ""}
        </h1>
        {needsSetup ? (
          <SetupForm onStepChange={setSetupStep} onError={setAuthError} />
        ) : (
          <LoginForm
            initialEmail={resolvedInitialEmail}
            onAuthenticated={handleAuthenticated}
            onError={setAuthError}
          />
        )}
      </div>
      <CopyableAuthError error={authError} onDismiss={() => setAuthError(null)} />
    </div>
  );
}
