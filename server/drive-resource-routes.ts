import type { Express, Response } from "express";
import { createLogger } from "./log";
import { driveResourceService } from "./drive-resource-service";
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
 * Drive resource routes. A drive_resource is an explicit vault-scoped binding to a Google Drive file
 * created via the Picker. Every handler resolves the caller's principal through driveResourceService,
 * which bounds all reads and writes to the caller's account.
 */
export function registerDriveResourceRoutes(app: Express) {
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
      const resource = await driveResourceService.bind({
        vaultId: String(body.vaultId ?? ""),
        connectedAccountId: String(body.connectedAccountId ?? ""),
        googleFileId: String(body.googleFileId ?? ""),
        name: String(body.name ?? ""),
        mimeType: typeof body.mimeType === "string" ? body.mimeType : null,
        resourceType: body.resourceType === "folder" ? "folder" : "file",
        iconUrl: typeof body.iconUrl === "string" ? body.iconUrl : null,
        webViewLink: typeof body.webViewLink === "string" ? body.webViewLink : null,
      });
      res.status(201).json({ resource });
    } catch (error) {
      handleError(res, error, "Failed to bind drive resource");
    }
  });

  // Mint a short-lived Picker session: a fresh access token (refresh token stays server-side) plus
  // the browser API key and app id. Returns configured=false when GOOGLE_PICKER_API_KEY is absent so
  // the client degrades honestly instead of opening a broken picker.
  app.get("/api/drive/picker-token", async (req, res) => {
    try {
      const connectedAccountId = typeof req.query.connectedAccountId === "string" ? req.query.connectedAccountId : "";
      if (!connectedAccountId) throw Object.assign(new Error("connectedAccountId is required"), { status: 400 });
      const apiKey = getSecretSync("GOOGLE_PICKER_API_KEY");
      const appId = getSecretSync("GOOGLE_CLIENT_ID")?.split("-")[0] || null;
      if (!apiKey) {
        res.json({ configured: false });
        return;
      }
      const { accessToken, expiresAt } = await getDriveAccessTokenForAccount(connectedAccountId);
      res.json({ configured: true, accessToken, apiKey, appId, expiresAt });
    } catch (error) {
      handleError(res, error, "Failed to create Drive picker session");
    }
  });

  app.delete("/api/drive/resources/:id", async (req, res) => {
    try {
      await driveResourceService.unbind(req.params.id);
      res.json({ removed: true });
    } catch (error) {
      handleError(res, error, "Failed to unbind drive resource");
    }
  });
}
