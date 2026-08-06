import type { Express, Response } from "express";
import { createLogger } from "./log";
import { driveResourceService } from "./drive-resource-service";
import { filesApi } from "./files-api";
import { getDriveAccessTokenForAccount } from "./gmail";
import { getSecretSync } from "./secrets-store";

const log = createLogger("DriveResourceRoutes");

function handleError(res: Response, error: unknown, fallback: string) {
  const status = (error as { status?: number })?.status ?? 500;
  const message = error instanceof Error ? error.message : fallback;
  if (status >= 500) log.error(fallback, { error: message });
  res.status(status).json({ error: message });
}

/**
 * Drive resource + Files API routes.
 *
 * Bind/unbind/picker stay on driveResourceService (explicit Picker whitelist).
 * All provider reads go through filesApi — connector-global, vault-gated,
 * object_grants-aware, owner-token only, fail-closed, read-only v1.
 */
export function registerDriveResourceRoutes(app: Express) {
  // ── Bind surface (Picker whitelist) ──────────────────────────────────────

  app.get("/api/drive/resources", async (req, res) => {
    try {
      const vaultId = typeof req.query.vaultId === "string" ? req.query.vaultId : "";
      if (!vaultId) throw Object.assign(new Error("vaultId is required"), { status: 400 });
      res.json({ resources: await driveResourceService.list(vaultId) });
    } catch (error) {
      handleError(res, error, "Failed to list drive resources");
    }
  });

  app.post("/api/drive/resources", async (req, res) => {
    try {
      const body = req.body ?? {};
      const providerRaw = body.provider == null ? "google" : String(body.provider);
      const provider =
        providerRaw === "box" || providerRaw === "mantra" || providerRaw === "google"
          ? providerRaw
          : null;
      if (!provider) {
        throw Object.assign(new Error("provider must be google, box, or mantra"), { status: 400 });
      }
      const providerFileId = String(body.providerFileId ?? "");
      const resource = await driveResourceService.bind({
        vaultId: String(body.vaultId ?? ""),
        connectedAccountId: String(body.connectedAccountId ?? ""),
        provider,
        providerFileId,
        name: String(body.name ?? ""),
        mimeType: body.mimeType == null ? null : String(body.mimeType),
        resourceType: body.resourceType === "folder" ? "folder" : "file",
        iconUrl: body.iconUrl == null ? null : String(body.iconUrl),
        webViewLink: body.webViewLink == null ? null : String(body.webViewLink),
      });
      res.status(201).json({ resource });
    } catch (error) {
      handleError(res, error, "Failed to bind drive resource");
    }
  });

  // Mint a short-lived Picker session: a fresh access token (refresh if needed)
  // plus the browser-safe Picker API key. Token is owner-scoped and never stored
  // client-side beyond the Picker session.
  app.post("/api/drive/picker-token", async (req, res) => {
    try {
      const connectedAccountId = String(req.body?.connectedAccountId ?? "");
      if (!connectedAccountId) {
        throw Object.assign(new Error("connectedAccountId is required"), { status: 400 });
      }
      const { accessToken, expiresAt } =
        await getDriveAccessTokenForAccount(connectedAccountId);
      const apiKey = getSecretSync("GOOGLE_PICKER_API_KEY");
      const appId = getSecretSync("GOOGLE_CLIENT_ID")?.split("-")[0] || null;
      if (!apiKey) {
        res.json({ configured: false });
        return;
      }
      // developerKey is the Picker SDK field name; apiKey kept for compatibility.
      res.json({
        configured: true,
        accessToken,
        expiresAt,
        developerKey: apiKey,
        apiKey,
        appId,
      });
    } catch (error) {
      handleError(res, error, "Failed to mint picker token");
    }
  });

  app.get("/api/drive/picker-config", async (_req, res) => {
    try {
      const apiKey = getSecretSync("GOOGLE_PICKER_API_KEY");
      const appId = getSecretSync("GOOGLE_CLIENT_ID")?.split("-")[0] || null;
      if (!apiKey) {
        res.json({ configured: false });
        return;
      }
      res.json({ configured: true, developerKey: apiKey, apiKey, appId });
    } catch (error) {
      handleError(res, error, "Failed to load picker config");
    }
  });

  app.delete("/api/drive/resources/:id", async (req, res) => {
    try {
      await driveResourceService.unbind(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      handleError(res, error, "Failed to unbind drive resource");
    }
  });

  // ── Files API (connector-global read path) ───────────────────────────────
  // GET  /api/files/bound?vaultId=
  // GET  /api/files/children?vaultId=&driveResourceId= | &provider=&providerFileId=
  // GET  /api/files/metadata?vaultId=&driveResourceId= | &provider=&providerFileId=
  // GET  /api/files/read?vaultId=&driveResourceId= | &provider=&providerFileId=
  // POST /api/files/authorize  { driveResourceId, required? }

  app.get("/api/files/bound", async (req, res) => {
    try {
      const vaultId = typeof req.query.vaultId === "string" ? req.query.vaultId : "";
      if (!vaultId) throw Object.assign(new Error("vaultId is required"), { status: 400 });
      res.json({ resources: await filesApi.listBound(vaultId) });
    } catch (error) {
      handleError(res, error, "Failed to list bound files");
    }
  });

  app.get("/api/files/children", async (req, res) => {
    try {
      const vaultId = typeof req.query.vaultId === "string" ? req.query.vaultId : "";
      if (!vaultId) throw Object.assign(new Error("vaultId is required"), { status: 400 });
      const driveResourceId =
        typeof req.query.driveResourceId === "string" ? req.query.driveResourceId : undefined;
      const provider =
        typeof req.query.provider === "string" ? req.query.provider : undefined;
      const providerFileId =
        typeof req.query.providerFileId === "string"
          ? req.query.providerFileId
          : undefined;
      const pageToken =
        typeof req.query.pageToken === "string" ? req.query.pageToken : undefined;
      const result = await filesApi.listChildren({
        vaultId,
        driveResourceId,
        provider: provider as "google" | "box" | "mantra" | undefined,
        providerFileId,
        pageToken,
      });
      res.json(result);
    } catch (error) {
      handleError(res, error, "Failed to list file children");
    }
  });

  app.get("/api/files/metadata", async (req, res) => {
    try {
      const vaultId = typeof req.query.vaultId === "string" ? req.query.vaultId : "";
      if (!vaultId) throw Object.assign(new Error("vaultId is required"), { status: 400 });
      const driveResourceId =
        typeof req.query.driveResourceId === "string" ? req.query.driveResourceId : undefined;
      const provider =
        typeof req.query.provider === "string" ? req.query.provider : undefined;
      const providerFileId =
        typeof req.query.providerFileId === "string"
          ? req.query.providerFileId
          : undefined;
      res.json({
        metadata: await filesApi.getMetadata({
          vaultId,
          driveResourceId,
          provider: provider as "google" | "box" | "mantra" | undefined,
          providerFileId,
        }),
      });
    } catch (error) {
      handleError(res, error, "Failed to load file metadata");
    }
  });

  app.get("/api/files/read", async (req, res) => {
    try {
      const vaultId = typeof req.query.vaultId === "string" ? req.query.vaultId : "";
      if (!vaultId) throw Object.assign(new Error("vaultId is required"), { status: 400 });
      const driveResourceId =
        typeof req.query.driveResourceId === "string" ? req.query.driveResourceId : undefined;
      const provider =
        typeof req.query.provider === "string" ? req.query.provider : undefined;
      const providerFileId =
        typeof req.query.providerFileId === "string"
          ? req.query.providerFileId
          : undefined;
      res.json(
        await filesApi.read({
          vaultId,
          driveResourceId,
          provider: provider as "google" | "box" | "mantra" | undefined,
          providerFileId,
        }),
      );
    } catch (error) {
      handleError(res, error, "Failed to read file");
    }
  });

  app.post("/api/files/authorize", async (req, res) => {
    try {
      const driveResourceId = String(req.body?.driveResourceId ?? "");
      if (!driveResourceId) {
        throw Object.assign(new Error("driveResourceId is required"), { status: 400 });
      }
      const required =
        req.body?.required === "write" || req.body?.required === "admin"
          ? req.body.required
          : "read";
      const resource = await filesApi.authorize(driveResourceId, required);
      res.json({ ok: true, resource });
    } catch (error) {
      handleError(res, error, "Failed to authorize file access");
    }
  });
}
