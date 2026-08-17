/**
 * Per-connector auth for model connectors.
 * Subscription OAuth + plain secrets bind to provider_connections.id.
 */
import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { createLogger } from "../log";
import { storeSubscriptionPkce, consumeSubscriptionPkce } from "../subscription-oauth-transactions";
import {
  getConnectorAuthStatus,
  getConnectorRow,
  storeConnectorSubscriptionTokens,
  storeConnectorSecret,
  disconnectConnectorAuth,
  findLegacyConnectorId,
  type SubscriptionProvider,
} from "../model-connector-credentials";
import type { ModelConnectorProvider } from "@shared/model-connectors";

const log = createLogger("ModelConnectorAuthRoutes");

const OPENAI_SUBSCRIPTION_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_SUBSCRIPTION_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_SUBSCRIPTION_AUTH_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_SUBSCRIPTION_SCOPES = "openid profile email offline_access";
const OPENAI_SUBSCRIPTION_REDIRECT_URI = "http://localhost:1455/auth/callback";

const GROK_SUBSCRIPTION_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_SUBSCRIPTION_AUTH_URL = "https://auth.x.ai/oauth2/authorize";
const GROK_SUBSCRIPTION_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const GROK_SUBSCRIPTION_SCOPES = "openid profile email offline_access grok-cli:access api:access";
const GROK_SUBSCRIPTION_REDIRECT_URI = "http://127.0.0.1:56121/callback";

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function parseConnectorId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid connector id");
  return id;
}

async function requireSubscriptionConnector(connectorId: number, provider: SubscriptionProvider) {
  const row = await getConnectorRow(connectorId);
  if (!row) {
    const err = new Error("Model connector not found");
    (err as any).status = 404;
    throw err;
  }
  if (row.provider !== provider) {
    const err = new Error(`Connector is ${row.provider}, expected ${provider}`);
    (err as any).status = 400;
    throw err;
  }
  return row;
}

export function registerModelConnectorAuthRoutes(app: Express): void {
  // Static path before :id so "by-provider" is never parsed as a connector id.
  app.get(
    "/api/models/connectors/by-provider/:provider",
    requireAuth,
    requirePermission("system:read"),
    async (req: Request, res: Response) => {
      try {
        const provider = req.params.provider as ModelConnectorProvider;
        const id = await findLegacyConnectorId(provider);
        if (!id) return res.status(404).json({ error: "No legacy connector for provider" });
        res.json({ id, provider });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/api/models/connectors/:id/auth-status",
    requireAuth,
    requirePermission("system:read"),
    async (req: Request, res: Response) => {
      try {
        const connectorId = parseConnectorId(req.params.id);
        const status = await getConnectorAuthStatus(connectorId);
        res.json(status);
      } catch (error: any) {
        res.status(error.status || 500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/api/models/connectors/:id/secret",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const connectorId = parseConnectorId(req.params.id);
        const { secret } = z.object({ secret: z.string().min(1) }).parse(req.body);
        const row = await getConnectorRow(connectorId);
        if (!row) return res.status(404).json({ error: "Model connector not found" });
        if (row.provider === "openai-subscription" || row.provider === "grok-subscription") {
          return res.status(400).json({ error: "Use OAuth for subscription connectors" });
        }
        await storeConnectorSecret(connectorId, secret, req.principal?.userId ?? null);
        res.json({ ok: true, ...(await getConnectorAuthStatus(connectorId)) });
      } catch (error: any) {
        res.status(error.status || 400).json({ error: error.message });
      }
    },
  );

  app.post(
    "/api/models/connectors/:id/disconnect",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const connectorId = parseConnectorId(req.params.id);
        await disconnectConnectorAuth(connectorId);
        res.json({ disconnected: true, ...(await getConnectorAuthStatus(connectorId)) });
      } catch (error: any) {
        res.status(error.status || 500).json({ error: error.message });
      }
    },
  );

  // ─── OpenAI Subscription (connector-scoped) ───────────────────────────────

  app.get(
    "/api/models/connectors/:id/openai-subscription/oauth/start",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const connectorId = parseConnectorId(req.params.id);
        await requireSubscriptionConnector(connectorId, "openai-subscription");
        const { codeVerifier, codeChallenge } = generatePKCE();
        const state = crypto.randomBytes(16).toString("hex");
        await storeSubscriptionPkce({
          state,
          codeVerifier,
          redirectUri: OPENAI_SUBSCRIPTION_REDIRECT_URI,
          provider: "openai-subscription",
          connectorId,
        });
        const params = new URLSearchParams({
          response_type: "code",
          client_id: OPENAI_SUBSCRIPTION_CLIENT_ID,
          redirect_uri: OPENAI_SUBSCRIPTION_REDIRECT_URI,
          scope: OPENAI_SUBSCRIPTION_SCOPES,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state,
          id_token_add_organizations: "true",
          codex_cli_simplified_flow: "true",
        });
        res.json({ url: `${OPENAI_SUBSCRIPTION_AUTH_URL}?${params.toString()}`, state });
      } catch (error: any) {
        res.status(error.status || 500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/api/models/connectors/:id/openai-subscription/oauth/exchange",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const connectorId = parseConnectorId(req.params.id);
        await requireSubscriptionConnector(connectorId, "openai-subscription");
        const { code, state } = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(req.body);
        const pkce = await consumeSubscriptionPkce(String(state), "openai-subscription");
        if (!pkce || (pkce.connectorId != null && pkce.connectorId !== connectorId)) {
          return res.status(400).json({ error: "Invalid or expired state" });
        }
        const tokenParams = new URLSearchParams({
          client_id: OPENAI_SUBSCRIPTION_CLIENT_ID,
          code: String(code),
          redirect_uri: pkce.redirectUri,
          grant_type: "authorization_code",
          code_verifier: pkce.codeVerifier,
        });
        const tokenResponse = await fetch(OPENAI_SUBSCRIPTION_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenParams.toString(),
        });
        if (!tokenResponse.ok) {
          throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
        }
        const tokens = await tokenResponse.json() as {
          access_token: string;
          refresh_token?: string;
          token_type: string;
          expires_in?: number;
          id_token?: string;
        };
        let email = "";
        let name = "";
        if (tokens.id_token) {
          try {
            const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
            email = payload.email || "";
            name = payload.name || payload.email || "";
          } catch { /* ignore */ }
        }
        await storeConnectorSubscriptionTokens(connectorId, {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type,
          expiry_date: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
          email,
          label: name || email || "ChatGPT Account",
        }, req.principal?.userId ?? null);
        res.json({ success: true, email, ...(await getConnectorAuthStatus(connectorId)) });
      } catch (error: any) {
        log.warn("openai connector oauth exchange failed", { error: error.message });
        res.status(error.status || 500).json({ error: error.message });
      }
    },
  );

  // ─── Grok Subscription (connector-scoped) ─────────────────────────────────

  app.get(
    "/api/models/connectors/:id/grok-subscription/oauth/start",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const connectorId = parseConnectorId(req.params.id);
        await requireSubscriptionConnector(connectorId, "grok-subscription");
        const { codeVerifier, codeChallenge } = generatePKCE();
        const state = crypto.randomBytes(16).toString("hex");
        const nonce = crypto.randomBytes(16).toString("hex");
        await storeSubscriptionPkce({
          state,
          codeVerifier,
          redirectUri: GROK_SUBSCRIPTION_REDIRECT_URI,
          provider: "grok-subscription",
          connectorId,
        });
        const params = new URLSearchParams({
          response_type: "code",
          client_id: GROK_SUBSCRIPTION_CLIENT_ID,
          redirect_uri: GROK_SUBSCRIPTION_REDIRECT_URI,
          scope: GROK_SUBSCRIPTION_SCOPES,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state,
          nonce,
          plan: "generic",
        });
        res.json({
          url: `${GROK_SUBSCRIPTION_AUTH_URL}?${params.toString()}`,
          state,
          redirectUri: GROK_SUBSCRIPTION_REDIRECT_URI,
        });
      } catch (error: any) {
        res.status(error.status || 500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/api/models/connectors/:id/grok-subscription/oauth/exchange",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const connectorId = parseConnectorId(req.params.id);
        await requireSubscriptionConnector(connectorId, "grok-subscription");
        let { code, state } = req.body as { code?: string; state?: string };
        if (code && code.includes("://")) {
          try {
            const parsed = new URL(code.trim());
            code = parsed.searchParams.get("code") || code;
            state = state || parsed.searchParams.get("state") || undefined;
          } catch { /* raw code */ }
        }
        code = code?.trim();
        if (!code || !state) return res.status(400).json({ error: "Missing code or state" });
        const pkce = await consumeSubscriptionPkce(String(state), "grok-subscription");
        if (!pkce || (pkce.connectorId != null && pkce.connectorId !== connectorId)) {
          return res.status(400).json({ error: "Invalid or expired state. Restart the connection." });
        }
        const tokenParams = new URLSearchParams({
          client_id: GROK_SUBSCRIPTION_CLIENT_ID,
          code,
          redirect_uri: pkce.redirectUri,
          grant_type: "authorization_code",
          code_verifier: pkce.codeVerifier,
        });
        const tokenResponse = await fetch(GROK_SUBSCRIPTION_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenParams.toString(),
        });
        if (!tokenResponse.ok) {
          throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
        }
        const tokens = await tokenResponse.json() as {
          access_token: string;
          refresh_token?: string;
          token_type?: string;
          expires_in?: number;
          id_token?: string;
        };
        let email = "";
        let name = "";
        if (tokens.id_token) {
          try {
            const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
            email = payload.email || "";
            name = payload.name || payload.email || "";
          } catch { /* ignore */ }
        }
        await storeConnectorSubscriptionTokens(connectorId, {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type || "Bearer",
          expiry_date: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
          email,
          label: name || email || "Grok Account",
        }, req.principal?.userId ?? null);
        res.json({ success: true, email, ...(await getConnectorAuthStatus(connectorId)) });
      } catch (error: any) {
        log.warn("grok connector oauth exchange failed", { error: error.message });
        res.status(error.status || 500).json({ error: error.message });
      }
    },
  );

  }
