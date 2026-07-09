import type { Express } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { db } from "../db";
import { vaults, users } from "@shared/schema";
import { getPrincipal } from "../principal";
import { assertVisible } from "../scoped-storage";

const log = createLogger("VaultRoutes");

export function registerVaultRoutes(app: Express) {
  app.use("/api/vaults", requireAuth);

  /**
   * GET /api/vaults — list the user's vaults plus their visible set and active vault.
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
}
