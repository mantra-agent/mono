import type { Express } from "express";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db } from "../db";
import { projectVaultMemberships, projects, vaults, users } from "@shared/schema";
import { getPrincipal } from "../principal";
import { assertVisible, assertWritable } from "../scoped-storage";
import {
  analyzeVaultR2Migration,
  getVaultR2MigrationStatus,
  startVaultR2Migration,
} from "../object_storage/vault-migration";

const log = createLogger("VaultRoutes");

export function registerVaultRoutes(app: Express) {
  app.use("/api/vaults", requireAuth);

  const migrationAdmin = requirePermission("system:write");

  app.get("/api/vaults/migration", migrationAdmin, async (req, res) => {
    try {
      const principal = getPrincipal(req);
      res.json(await getVaultR2MigrationStatus(principal));
    } catch (error) {
      log.error("GET /api/vaults/migration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load migration status" });
    }
  });

  app.post("/api/vaults/migration/analyze", migrationAdmin, async (req, res) => {
    try {
      const principal = getPrincipal(req);
      res.json(await analyzeVaultR2Migration(principal));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to analyze migration";
      log.error("POST /api/vaults/migration/analyze failed", { error: message });
      res.status(message.includes("already active") ? 409 : 500).json({ error: message });
    }
  });

  app.post("/api/vaults/migration/start", migrationAdmin, async (req, res) => {
    try {
      const principal = getPrincipal(req);
      res.json(await startVaultR2Migration(principal));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start migration";
      log.error("POST /api/vaults/migration/start failed", { error: message });
      const status = message.includes("already active") ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  /**
   * GET /api/vaults — list the user's vaults plus their visible set and active vault.
   * Excludes archived vaults by default.
   */
  app.get("/api/vaults", async (req, res) => {
    try {
      const principal = getPrincipal(req);
      if (!principal || !principal.accountId) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const allVaults = await db
        .select()
        .from(vaults)
        .where(
          and(
            eq(vaults.accountId, principal.accountId),
            eq(vaults.isArchived, false),
          ),
        )
        .orderBy(vaults.position, vaults.createdAt);

      res.json({
        vaults: allVaults,
        visibleVaultIds: principal.visibleVaultIds,
        activeVaultId: principal.activeVaultId,
      });
    } catch (error) {
      log.error("GET /api/vaults failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Failed to list vaults" });
    }
  });

  const toggleSchema = z.object({
    vaultId: z.string().min(1),
    visible: z.boolean(),
  });

  /**
   * PATCH /api/vaults/toggle — toggle a vault's visibility in the user's visible set.
   *
   * Invariant 1 (A.4): the active vault cannot be toggled off.
   * Toggling on adds to visible set. Toggling off removes (unless active).
   */
  app.patch("/api/vaults/toggle", async (req, res) => {
    try {
      const principal = getPrincipal(req);
      if (!principal || !principal.userId || !principal.accountId) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const parsed = toggleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const { vaultId, visible } = parsed.data;

      // Verify the vault exists and belongs to this account
      const [vault] = await db
        .select()
        .from(vaults)
        .where(and(eq(vaults.id, vaultId), eq(vaults.accountId, principal.accountId)))
        .limit(1);

      assertVisible(principal, vault as Record<string, unknown> | undefined, "vault");

      // Invariant 1: cannot toggle off the active vault
      if (!visible && principal.activeVaultId === vaultId) {
        return res.status(400).json({
          error: "This is your active vault. Switch active vault first.",
        });
      }

      // Compute updated visible set
      const currentVisible = new Set(principal.visibleVaultIds);
      if (visible) {
        currentVisible.add(vaultId);
      } else {
        currentVisible.delete(vaultId);
      }
      const updatedVisibleIds = Array.from(currentVisible);

      // Persist to users table
      await db
        .update(users)
        .set({
          visibleVaultIds: updatedVisibleIds,
        })
        .where(eq(users.id, principal.userId));

      log.info("vault visibility toggled", {
        userId: principal.userId,
        vaultId,
        visible,
        visibleVaultIds: updatedVisibleIds,
      });

      res.json({ visibleVaultIds: updatedVisibleIds });
    } catch (error: unknown) {
      if (error && typeof error === "object" && "status" in error && (error as { status: number }).status === 404) {
        return res.status(404).json({ error: (error as Error).message });
      }
      log.error("PATCH /api/vaults/toggle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Failed to toggle vault visibility" });
    }
  });

  const setActiveSchema = z.object({
    vaultId: z.string().min(1),
  });

  /**
   * PATCH /api/vaults/active — set the active (write-target) vault.
   *
   * Invariant 1 (A.4): setting a vault active also adds it to the visible set.
   */
  app.patch("/api/vaults/active", async (req, res) => {
    try {
      const principal = getPrincipal(req);
      if (!principal || !principal.userId || !principal.accountId) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const parsed = setActiveSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const { vaultId } = parsed.data;

      // Verify the vault exists and belongs to this account
      const [vault] = await db
        .select()
        .from(vaults)
        .where(and(eq(vaults.id, vaultId), eq(vaults.accountId, principal.accountId)))
        .limit(1);

      assertVisible(principal, vault as Record<string, unknown> | undefined, "vault");

      // Invariant 1: setting active also adds to visible set
      const currentVisible = new Set(principal.visibleVaultIds);
      currentVisible.add(vaultId);
      const updatedVisibleIds = Array.from(currentVisible);

      // Persist both active vault and updated visible set
      await db
        .update(users)
        .set({
          activeVaultId: vaultId,
          visibleVaultIds: updatedVisibleIds,
        })
        .where(eq(users.id, principal.userId));

      log.info("active vault changed", {
        userId: principal.userId,
        previousActiveVaultId: principal.activeVaultId,
        newActiveVaultId: vaultId,
        visibleVaultIds: updatedVisibleIds,
      });

      res.json({
        activeVaultId: vaultId,
        visibleVaultIds: updatedVisibleIds,
      });
    } catch (error: unknown) {
      if (error && typeof error === "object" && "status" in error && (error as { status: number }).status === 404) {
        return res.status(404).json({ error: (error as Error).message });
      }
      log.error("PATCH /api/vaults/active failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Failed to set active vault" });
    }
  });

  // --- Management endpoints (registered after /toggle and /active to avoid :id collision) ---

  const createVaultSchema = z.object({
    name: z.string().min(1).max(100),
    color: z.string().max(20).optional(),
    icon: z.string().max(4).optional(),
    purpose: z.string().max(500).optional(),
  });

  /**
   * POST /api/vaults — create a new vault for the principal's account.
   *
   * The new vault is added to the user's visible set but does NOT become
   * active automatically (the active vault remains unchanged).
   * Enforces unique name per account via DB constraint.
   */
  app.post("/api/vaults", async (req, res) => {
    try {
      const principal = getPrincipal(req);
      if (!principal || !principal.userId || !principal.accountId) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const parsed = createVaultSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const { name, color, icon, purpose } = parsed.data;

      // Determine position: next after the highest existing position
      const [maxPos] = await db
        .select({ maxPosition: sql<number>`COALESCE(MAX(${vaults.position}), -1)` })
        .from(vaults)
        .where(eq(vaults.accountId, principal.accountId));

      const nextPosition = (maxPos?.maxPosition ?? -1) + 1;

      // Insert the new vault
      const [newVault] = await db
        .insert(vaults)
        .values({
          accountId: principal.accountId,
          name,
          color: color || null,
          icon: icon || name.slice(0, 2).toUpperCase(),
          purpose: purpose || null,
          position: nextPosition,
          isDefault: false,
          isArchived: false,
        })
        .returning();

      // Add to the user's visible set (invariant: new vault is visible but not active)
      const currentVisible = new Set(principal.visibleVaultIds);
      currentVisible.add(newVault.id);
      const updatedVisibleIds = Array.from(currentVisible);

      await db
        .update(users)
        .set({ visibleVaultIds: updatedVisibleIds })
        .where(eq(users.id, principal.userId));

      log.info("vault created", {
        userId: principal.userId,
        vaultId: newVault.id,
        name,
        visibleVaultIds: updatedVisibleIds,
      });

      res.status(201).json({ vault: newVault, visibleVaultIds: updatedVisibleIds });
    } catch (error: unknown) {
      // Handle unique constraint violation (duplicate name)
      if (
        error instanceof Error &&
        error.message.includes("idx_vaults_account_name_unique")
      ) {
        return res.status(409).json({ error: "A vault with that name already exists" });
      }
      log.error("POST /api/vaults failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Failed to create vault" });
    }
  });

  const updateVaultSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    color: z.string().max(20).optional(),
    icon: z.string().max(4).optional(),
    purpose: z.string().max(500).optional(),
  });

  /**
   * PATCH /api/vaults/:id — rename or update vault properties (color, icon, purpose).
   *
   * Uses assertWritable to ensure the vault belongs to the requesting user's account.
   */
  app.patch("/api/vaults/:id", async (req, res) => {
    try {
      const principal = getPrincipal(req);
      if (!principal || !principal.userId || !principal.accountId) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const vaultId = req.params.id;

      const parsed = updateVaultSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      // Fetch the vault
      const [vault] = await db
        .select()
        .from(vaults)
        .where(and(eq(vaults.id, vaultId), eq(vaults.accountId, principal.accountId)))
        .limit(1);

      assertWritable(principal, vault as Record<string, unknown> | undefined, "vault");

      // Build update set from provided fields only (safe partial update)
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.color !== undefined) updates.color = parsed.data.color;
      if (parsed.data.icon !== undefined) updates.icon = parsed.data.icon;
      if (parsed.data.purpose !== undefined) updates.purpose = parsed.data.purpose;

      const [updated] = await db
        .update(vaults)
        .set(updates)
        .where(eq(vaults.id, vaultId))
        .returning();

      log.info("vault updated", {
        userId: principal.userId,
        vaultId,
        fields: Object.keys(updates).filter((k) => k !== "updatedAt"),
      });

      res.json({ vault: updated });
    } catch (error: unknown) {
      if (error && typeof error === "object" && "status" in error) {
        const statusError = error as { status: number; message: string };
        return res.status(statusError.status).json({ error: statusError.message });
      }
      if (
        error instanceof Error &&
        error.message.includes("idx_vaults_account_name_unique")
      ) {
        return res.status(409).json({ error: "A vault with that name already exists" });
      }
      log.error("PATCH /api/vaults/:id failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Failed to update vault" });
    }
  });

  /**
   * DELETE /api/vaults/:id — archive a vault (soft delete).
   *
   * Archive semantics: the vault's isArchived flag is set to true.
   * Archived vaults are excluded from GET /api/vaults default listing
   * and removed from the user's visible set. Data inside the vault
   * remains intact and hidden (the vault becomes invisible to queries).
   *
   * Guards:
   * - Cannot archive the active vault ("Switch active vault first")
   * - Cannot archive the last remaining non-archived vault
   */
  app.delete("/api/vaults/:id", async (req, res) => {
    try {
      const principal = getPrincipal(req);
      if (!principal || !principal.userId || !principal.accountId) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const vaultId = req.params.id;

      // Fetch the vault
      const [vault] = await db
        .select()
        .from(vaults)
        .where(and(eq(vaults.id, vaultId), eq(vaults.accountId, principal.accountId)))
        .limit(1);

      assertWritable(principal, vault as Record<string, unknown> | undefined, "vault");

      // Guard: cannot archive the active vault
      if (principal.activeVaultId === vaultId) {
        return res.status(400).json({
          error: "Switch active vault first",
        });
      }

      // Guard: cannot archive the last remaining non-archived vault
      const [countResult] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(vaults)
        .where(
          and(
            eq(vaults.accountId, principal.accountId),
            eq(vaults.isArchived, false),
          ),
        );

      if ((countResult?.count ?? 0) <= 1) {
        return res.status(400).json({
          error: "Cannot archive your last vault",
        });
      }

      const archived = await db.transaction(async tx => {
        await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, `vault:${vaultId}`);
        const projectsLosingLastMembership = await tx
          .select({ id: projects.id })
          .from(projects)
          .innerJoin(
            projectVaultMemberships,
            and(
              eq(projectVaultMemberships.projectId, projects.id),
              eq(projectVaultMemberships.vaultId, vaultId),
            ),
          )
          .where(and(
            eq(projects.accountId, principal.accountId),
            eq(projects.ownerUserId, principal.userId),
            sql`NOT EXISTS (
              SELECT 1
              FROM project_vault_memberships AS remaining_membership
              JOIN vaults AS remaining_vault
                ON remaining_vault.id = remaining_membership.vault_id
               AND remaining_vault.is_archived = FALSE
              WHERE remaining_membership.project_id = ${projects.id}
                AND remaining_membership.vault_id <> ${vaultId}
            )`,
          ))
          .limit(1);
        if (projectsLosingLastMembership.length > 0) return false;
        await tx
          .update(vaults)
          .set({ isArchived: true, updatedAt: new Date() })
          .where(and(
            eq(vaults.id, vaultId),
            eq(vaults.accountId, principal.accountId),
            eq(vaults.isArchived, false),
          ));
        return true;
      });
      if (!archived) {
        return res.status(400).json({
          error: "Move every Project in this Vault to another Vault before archiving it",
        });
      }

      // Remove from visible set
      const currentVisible = new Set(principal.visibleVaultIds);
      currentVisible.delete(vaultId);
      const updatedVisibleIds = Array.from(currentVisible);

      await db
        .update(users)
        .set({ visibleVaultIds: updatedVisibleIds })
        .where(eq(users.id, principal.userId));

      log.info("vault archived", {
        userId: principal.userId,
        vaultId,
        visibleVaultIds: updatedVisibleIds,
      });

      res.json({ archived: true, visibleVaultIds: updatedVisibleIds });
    } catch (error: unknown) {
      if (error && typeof error === "object" && "status" in error) {
        const statusError = error as { status: number; message: string };
        return res.status(statusError.status).json({ error: statusError.message });
      }
      log.error("DELETE /api/vaults/:id failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Failed to archive vault" });
    }
  });
}
