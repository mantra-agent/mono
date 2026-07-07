import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { createLogger } from "@/lib/logger";

const authLog = createLogger("AuthClient");

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

export interface AuthPrincipal {
  actorType: string;
  userId: string | null;
  accountId: string | null;
  role: string;
  scopes: string[];
  permissions: string[];
  isAdmin: boolean;
  source: string;
}

interface AuthState {
  user: AuthUser | null;
  principal: AuthPrincipal | null;
  permissions: string[];
  isLoading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  hasPermission: (permission: string) => boolean;
}

export function useAuth(): AuthState {
  const { data, isLoading } = useQuery<{ user: AuthUser; principal?: AuthPrincipal | null } | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      authLog.info("me:start", { url: "/api/auth/me" });
      const res = await fetch("/api/auth/me", { credentials: "include" });
      authLog.info("me:response", {
        status: res.status,
        ok: res.ok,
        redirected: res.redirected,
        type: res.type,
        url: res.url,
      });
      if (res.status === 401) return null;
      if (!res.ok) return null;
      const body = await res.json();
      authLog.info("me:success", { hasUser: Boolean(body?.user), userId: body?.user?.id ?? null });
      return body;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const user = data?.user ?? null;
  const principal = data?.principal ?? null;
  const permissions = principal?.permissions ?? [];

  return {
    user,
    principal,
    permissions,
    isLoading,
    isAuthenticated: !!user,
    isAdmin: permissions.includes("system:write"),
    hasPermission: (permission: string) => permissions.includes(permission),
  };
}

export function useLogin() {
  return useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      authLog.info("login:start", { emailHashHint: data.email.slice(0, 2) + "***" });
      const res = await apiRequest("POST", "/api/auth/login", data);
      authLog.info("login:response", { status: res.status, ok: res.ok, type: res.type, url: res.url });
      const body = await res.json() as { user: AuthUser; principal?: AuthPrincipal | null };
      authLog.info("login:body", { hasUser: Boolean(body?.user), userId: body?.user?.id ?? null });
      return body;
    },
    onSuccess: (data) => {
      authLog.info("login:on-success", { userId: data?.user?.id ?? null });
      // Keep the server-returned authenticated state as the source of truth for
      // this turn. Immediately invalidating /api/auth/me can race the browser
      // cookie handoff in embedded Stage and overwrite success with a transient
      // 401, bouncing the user back to sign-in.
      queryClient.setQueryData(["/api/auth/me"], data);
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
    },
  });
}

export function useLogout() {
  return useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      queryClient.setQueryData(["/api/auth/me"], null);
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
  });
}

export function useSetup() {
  return useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      const res = await apiRequest("POST", "/api/auth/setup", data);
      const body = await res.json() as { user: AuthUser; principal?: AuthPrincipal | null };
      return body;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/auth/me"], data);
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
    },
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: async (data: { email: string; password: string; inviteToken?: string }) => {
      authLog.info("register:start", { emailHashHint: data.email.slice(0, 2) + "***" });
      const res = await apiRequest("POST", "/api/auth/register", data);
      authLog.info("register:response", { status: res.status, ok: res.ok, type: res.type, url: res.url });
      const body = await res.json() as { user: AuthUser; principal?: AuthPrincipal | null };
      authLog.info("register:body", { hasUser: Boolean(body?.user), userId: body?.user?.id ?? null });
      return body;
    },
    onSuccess: (data) => {
      // Registration also returns an authenticated user. Do not immediately
      // refetch /api/auth/me in the same tick; keep the returned state and let
      // normal stale-time revalidation happen after the cookie is settled.
      queryClient.setQueryData(["/api/auth/me"], data);
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
    },
  });
}

export function useAuthStatus() {
  return useQuery<{ setupComplete: boolean }>({
    queryKey: ["/api/auth/status"],
    staleTime: 30 * 1000,
  });
}
