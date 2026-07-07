import type { Express } from "express";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "../scoped-storage";
import { storeProviderCredential, getProviderCredential, deleteProviderCredential } from "../provider-credential-store";
import { providerConnections, environmentSourceBindings, environmentHostingBindings, insertProviderConnectionSchema } from "@shared/models/platforms";
import { testRailwayToken, testGitHubToken, testCloudflareToken } from "../services/provider-connection-service";

const log = createLogger("ProviderConnectionRoutes");

const scopeColumns = {
  scope: providerConnections.scope,
  ownerUserId: providerConnections.ownerUserId,
  accountId: providerConnections.accountId,
};

function visibleConnection(predicate?: SQL): SQL {
  return combineWithVisibleScope(getCurrentPrincipalOrSystem(), scopeColumns, predicate);
}

function writableConnection(predicate?: SQL): SQL {
  return combineWithWritableScope(getCurrentPrincipalOrSystem(), scopeColumns, predicate);
}

function routeError(error: unknown, operation: string): { message: string; operation: string } {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`${operation} failed: ${message}`);
  return { message, operation };
}

export function registerProviderConnectionRoutes(app: Express): void {
  app.use("/api/provider-connections", requireAuth);

  // List all visible connections (never returns credential values)
  app.get("/api/provider-connections", async (_req, res) => {
    try {
      const rows = await db
        .select({
          id: providerConnections.id,
          provider: providerConnections.provider,
          label: providerConnections.label,
          accountType: providerConnections.accountType,
          status: providerConnections.status,
          lastVerifiedAt: providerConnections.lastVerifiedAt,
          createdAt: providerConnections.createdAt,
          updatedAt: providerConnections.updatedAt,
        })
        .from(providerConnections)
        .where(visibleConnection())
        .orderBy(providerConnections.updatedAt);
      res.json(rows);
    } catch (error) {
      const err = routeError(error, "list_provider_connections");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  // Get single connection (no credential value)
  app.get("/api/provider-connections/:id", async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id", operation: "get_provider_connection" });

      const [row] = await db
        .select({
          id: providerConnections.id,
          provider: providerConnections.provider,
          label: providerConnections.label,
          accountType: providerConnections.accountType,
          status: providerConnections.status,
          credentialRef: providerConnections.credentialRef,
          lastVerifiedAt: providerConnections.lastVerifiedAt,
          createdAt: providerConnections.createdAt,
          updatedAt: providerConnections.updatedAt,
        })
        .from(providerConnections)
        .where(visibleConnection(eq(providerConnections.id, id)))
        .limit(1);

      if (!row) return res.status(404).json({ error: "Connection not found", operation: "get_provider_connection" });
      res.json({ ...row, hasCredential: !!row.credentialRef });
    } catch (error) {
      const err = routeError(error, "get_provider_connection");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  // Create connection with encrypted credential
  app.post("/api/provider-connections", async (req, res) => {
    try {
      const { credential, ...rest } = req.body as Record<string, unknown>;
      const parsed = insertProviderConnectionSchema.parse(rest);
      const principal = getCurrentPrincipalOrSystem();

      // Insert the connection first to get the ID
      const [created] = await db
        .insert(providerConnections)
        .values({ ...parsed, ...ownedInsertValues(principal, scopeColumns) })
        .returning();

      // Store credential if provided
      if (credential && typeof credential === "string" && credential.trim()) {
        const ref = await storeProviderCredential(created.id, credential, principal.userId ?? null);
        await db
          .update(providerConnections)
          .set({ credentialRef: ref, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(providerConnections.id, created.id));
        created.credentialRef = ref;
      }

      // Return without credential value
      const { credentialRef: _ref, ...safeRow } = created;
      res.status(201).json({ ...safeRow, hasCredential: !!created.credentialRef });
    } catch (error) {
      const err = routeError(error, "create_provider_connection");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  // Update connection (label, re-encrypt credential)
  app.put("/api/provider-connections/:id", async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id", operation: "update_provider_connection" });

      const [existing] = await db
        .select()
        .from(providerConnections)
        .where(writableConnection(eq(providerConnections.id, id)))
        .limit(1);
      if (!existing) return res.status(404).json({ error: "Connection not found", operation: "update_provider_connection" });

      const { credential, ...rest } = req.body as Record<string, unknown>;
      const updates: Record<string, unknown> = { updatedAt: sql`CURRENT_TIMESTAMP` };

      if (rest.label && typeof rest.label === "string") updates.label = rest.label.trim();
      if (rest.accountType && typeof rest.accountType === "string") updates.accountType = rest.accountType.trim();
      if (rest.status && typeof rest.status === "string") updates.status = rest.status;

      // Re-encrypt credential if provided
      const principal = getCurrentPrincipalOrSystem();
      if (credential && typeof credential === "string" && credential.trim()) {
        const ref = await storeProviderCredential(id, credential, principal.userId ?? null);
        updates.credentialRef = ref;
      }

      const [updated] = await db
        .update(providerConnections)
        .set(updates)
        .where(writableConnection(eq(providerConnections.id, id)))
        .returning();

      if (!updated) return res.status(404).json({ error: "Connection not found", operation: "update_provider_connection" });

      const { credentialRef: _ref, ...safeRow } = updated;
      res.json({ ...safeRow, hasCredential: !!updated.credentialRef });
    } catch (error) {
      const err = routeError(error, "update_provider_connection");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  // Delete connection (reject if bindings reference it)
  app.delete("/api/provider-connections/:id", async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id", operation: "delete_provider_connection" });

      const [existing] = await db
        .select()
        .from(providerConnections)
        .where(writableConnection(eq(providerConnections.id, id)))
        .limit(1);
      if (!existing) return res.status(404).json({ error: "Connection not found", operation: "delete_provider_connection" });

      // Check for referencing environment bindings
      let hasSourceBindings = false;
      let hasHostingBindings = false;
      try {
        const sourceRefs = await db
          .select({ id: environmentSourceBindings.id })
          .from(environmentSourceBindings)
          .where(eq(environmentSourceBindings.connectionId, id))
          .limit(1);
        hasSourceBindings = sourceRefs.length > 0;

        const hostingRefs = await db
          .select({ id: environmentHostingBindings.id })
          .from(environmentHostingBindings)
          .where(eq(environmentHostingBindings.connectionId, id))
          .limit(1);
        hasHostingBindings = hostingRefs.length > 0;
      } catch {
        // Tables may not exist yet — safe to proceed
      }

      if (hasSourceBindings || hasHostingBindings) {
        return res.status(409).json({
          error: "Cannot delete connection: it is referenced by environment bindings. Remove those bindings first.",
          operation: "delete_provider_connection",
        });
      }

      // Delete the stored credential
      if (existing.credentialRef) {
        await deleteProviderCredential(existing.credentialRef);
      }

      // Delete the connection row
      await db.delete(providerConnections).where(eq(providerConnections.id, id));
      res.json({ success: true });
    } catch (error) {
      const err = routeError(error, "delete_provider_connection");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  // Test connection
  app.post("/api/provider-connections/:id/test", async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id", operation: "test_provider_connection" });

      const [connection] = await db
        .select()
        .from(providerConnections)
        .where(visibleConnection(eq(providerConnections.id, id)))
        .limit(1);
      if (!connection) return res.status(404).json({ error: "Connection not found", operation: "test_provider_connection" });

      if (!connection.credentialRef) {
        return res.json({ ok: false, message: "No credential stored for this connection." });
      }

      const token = await getProviderCredential(connection.credentialRef);
      if (!token) {
        return res.json({ ok: false, message: "Credential could not be decrypted or is missing." });
      }

      let result: { ok: boolean; message: string; projects?: Array<{ id: string; name: string }> };

      switch (connection.provider) {
        case "railway":
          result = await testRailwayToken(token);
          break;
        case "github":
          result = await testGitHubToken(token);
          break;
        case "cloudflare":
          result = await testCloudflareToken(token);
          break;
        default:
          result = { ok: false, message: `No test implementation for provider: ${connection.provider}` };
      }

      // Update lastVerifiedAt on success
      if (result.ok) {
        await db
          .update(providerConnections)
          .set({ lastVerifiedAt: sql`CURRENT_TIMESTAMP`, status: "active", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(providerConnections.id, id));
      }

      res.json(result);
    } catch (error) {
      const err = routeError(error, "test_provider_connection");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });
}
