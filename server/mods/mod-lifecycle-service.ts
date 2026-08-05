import { and, eq } from "drizzle-orm";
import { userProfiles } from "@shared/schema";
import {
  ADVISORY_LOCK_NS,
  acquireAdvisoryTransactionLock,
  db,
  runWithDatabaseTransaction,
  type DrizzleTx,
} from "../db";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { principalHasPermission } from "../permissions";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
  type ScopeColumns,
} from "../scoped-storage";
import {
  MOD_KEYS,
  modEntitlements,
  modInstallations,
  type ModEntitlementRow,
  type ModEntitlementStatus,
  type ModInstallationRow,
  type ModKey,
} from "@shared/schema";
import {
  disableBuildManagedResources,
  materializeBuildManagedResources,
} from "./build-managed-resources";
import {
  disableWellnessManagedResources,
  materializeWellnessManagedResources,
} from "./wellness-managed-resources";
import {
  disableBusinessManagedResources,
  materializeBusinessManagedResources,
} from "./business-managed-resources";
import { timerStorage } from "../file-storage/timers";
import { isModPlatformEnabled } from "./mod-platform-config";

export { isModPlatformEnabled } from "./mod-platform-config";

const log = createLogger("mod-lifecycle");

/** Mods provisioned as active baseline defaults on every account. */
export const BASELINE_MOD_KEYS = ["planning", "network"] as const satisfies readonly ModKey[];

export class ModPlatformError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ModPlatformError";
    this.code = code;
    this.status = status;
  }
}

export class ModPlatformDisabledError extends ModPlatformError {
  constructor() {
    super("mod_platform_disabled", "Mod platform is disabled", 503);
  }
}

export interface EntitleInput {
  modKey: string;
  sourceType?: string;
  sourceId?: string;
  validFrom?: Date;
  validUntil?: Date;
}

export interface InstallInput {
  modKey: string;
  /** Manifest version last reconciled successfully; supplied by the caller/registry in later steps. */
  resolvedVersion?: string;
}

export interface DisableInput {
  modKey: string;
}

const entitlementScope: ScopeColumns = {
  scope: modEntitlements.scope,
  ownerUserId: modEntitlements.ownerUserId,
  accountId: modEntitlements.accountId,
};

const installationScope: ScopeColumns = {
  scope: modInstallations.scope,
  ownerUserId: modInstallations.ownerUserId,
  accountId: modInstallations.accountId,
};

interface AccountContext {
  userId: string;
  accountId: string;
}

/**
 * Canonical, idempotent, replayable mutation boundary for account-level Mod
 * entitlement and installation state. Every transition serializes on a single
 * per-account + per-Mod advisory lock and persists through scoped-storage
 * helpers. Build-managed Timer rows are adopted or created through the
 * installation-resource ledger; the installation state machine
 * (installing → active → disabling → disabled/error) is real and durable.
 */
export class ModLifecycleService {
  private assertEnabled(): void {
    if (!isModPlatformEnabled()) throw new ModPlatformDisabledError();
  }

  private assertManageAuthority(principal: Principal): void {
    if (!principalHasPermission(principal, "mods:manage")) {
      throw new ModPlatformError("mods_manage_required", "mods:manage permission required", 403);
    }
  }

  private assertEntitleAuthority(principal: Principal): void {
    // Entitlement writes require commercial/account administration authority.
    if (!principalHasPermission(principal, "system:write")) {
      throw new ModPlatformError(
        "entitlement_authority_required",
        "Commercial/admin authority required to grant entitlements",
        403,
      );
    }
  }

  private requireAccountContext(principal: Principal): AccountContext {
    if (!principal.userId || !principal.accountId) {
      throw new ModPlatformError(
        "account_context_required",
        "A resolved user+account principal is required",
        401,
      );
    }
    return { userId: principal.userId, accountId: principal.accountId };
  }

  private normalizeModKey(modKey: string): ModKey {
    const trimmed = (modKey ?? "").trim();
    if (!(MOD_KEYS as readonly string[]).includes(trimmed)) {
      throw new ModPlatformError("unknown_mod_key", `Unknown Mod key: ${trimmed || "(empty)"}`, 400);
    }
    return trimmed as ModKey;
  }

  /** Deterministic idempotency key: one lifecycle line per account + Mod. */
  private lockKey(accountId: string, modKey: ModKey): string {
    return `${accountId}:${modKey}`;
  }

  private entitlementIsActive(row: ModEntitlementRow | undefined, now: Date): boolean {
    if (!row) return false;
    const status: ModEntitlementStatus = row.status;
    if (status !== "granted") return false;
    if (row.validFrom && row.validFrom.getTime() > now.getTime()) return false;
    if (row.validUntil && row.validUntil.getTime() < now.getTime()) return false;
    return true;
  }

  /** Materialize managed rows without granting permissions or credentials. */
  private async materializeManagedResources(
    tx: DrizzleTx,
    principal: Principal,
    installation: ModInstallationRow,
    modKey: ModKey,
  ): Promise<void> {
    if (modKey === "business") {
      // Business owns no ledger-materialized resources; documented no-op keeps
      // dispatch symmetric with Build/Wellness and gives future Business
      // managed resources a canonical home. No timezone / timer cache touch.
      await materializeBusinessManagedResources(tx, principal, installation);
      return;
    }
    if (modKey !== "build" && modKey !== "wellness") return;
    const [profile] = await tx.select({ timezone: userProfiles.timezone })
      .from(userProfiles)
      .where(eq(userProfiles.userId, principal.userId!))
      .limit(1);
    const timezone = profile?.timezone?.trim() || "America/New_York";
    if (modKey === "build") {
      await materializeBuildManagedResources(tx, principal, installation, timezone);
    } else {
      await materializeWellnessManagedResources(tx, principal, installation, timezone);
    }
    timerStorage.invalidateCache();
  }

  /** Disable exact ledger-owned resources while retaining rows and history. */
  private async detachManagedResources(
    tx: DrizzleTx,
    principal: Principal,
    installation: ModInstallationRow,
  ): Promise<void> {
    if (installation.modKey === "build") {
      await disableBuildManagedResources(tx, principal, installation);
      timerStorage.invalidateCache();
      return;
    }
    if (installation.modKey === "wellness") {
      await disableWellnessManagedResources(tx, principal, installation);
      timerStorage.invalidateCache();
      return;
    }
    if (installation.modKey === "business") {
      await disableBusinessManagedResources(tx, principal, installation);
    }
  }

  /** Grant (or refresh) account-level entitlement. Idempotent by (account, Mod). */
  async entitle(principal: Principal, input: EntitleInput): Promise<ModEntitlementRow> {
    this.assertEnabled();
    this.assertEntitleAuthority(principal);
    const ctx = this.requireAccountContext(principal);
    const modKey = this.normalizeModKey(input.modKey);

    return db.transaction((tx) =>
      runWithDatabaseTransaction(tx, async () => {
        await acquireAdvisoryTransactionLock(
          tx,
          ADVISORY_LOCK_NS.MOD_LIFECYCLE,
          this.lockKey(ctx.accountId, modKey),
        );
        const now = new Date();
        const [row] = await tx
          .insert(modEntitlements)
          .values({
            modKey,
            status: "granted",
            sourceType: input.sourceType ?? null,
            sourceId: input.sourceId ?? null,
            validFrom: input.validFrom ?? null,
            validUntil: input.validUntil ?? null,
            ...ownedInsertValues(principal, entitlementScope),
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          })
          .onConflictDoUpdate({
            target: [modEntitlements.accountId, modEntitlements.modKey],
            set: {
              status: "granted",
              sourceType: input.sourceType ?? null,
              sourceId: input.sourceId ?? null,
              validFrom: input.validFrom ?? null,
              validUntil: input.validUntil ?? null,
              updatedByUserId: ctx.userId,
              updatedAt: now,
            },
          })
          .returning();
        if (!row) throw new ModPlatformError("entitlement_upsert_failed", "Entitlement upsert failed", 500);
        log.info("mod entitlement granted", { accountId: ctx.accountId, modKey });
        return row;
      }),
    );
  }

  /**
   * Install a Mod for the account. Confirms an active entitlement, drives the
   * installation state machine to `active`, and is safe to rerun after a crash.
   */
  async install(principal: Principal, input: InstallInput): Promise<ModInstallationRow> {
    this.assertEnabled();
    this.assertManageAuthority(principal);
    const ctx = this.requireAccountContext(principal);
    const modKey = this.normalizeModKey(input.modKey);

    return db.transaction((tx) =>
      runWithDatabaseTransaction(tx, async () => {
        await acquireAdvisoryTransactionLock(
          tx,
          ADVISORY_LOCK_NS.MOD_LIFECYCLE,
          this.lockKey(ctx.accountId, modKey),
        );
        const now = new Date();

        const [entitlement] = await tx
          .select()
          .from(modEntitlements)
          .where(combineWithVisibleScope(principal, entitlementScope, eq(modEntitlements.modKey, modKey)))
          .limit(1);
        if (!this.entitlementIsActive(entitlement, now)) {
          throw new ModPlatformError(
            "entitlement_required",
            `Account is not entitled to install Mod: ${modKey}`,
            403,
          );
        }

        const [existing] = await tx
          .select()
          .from(modInstallations)
          .where(combineWithWritableScope(principal, installationScope, eq(modInstallations.modKey, modKey)))
          .limit(1);
        if (existing?.status === "active") {
          await this.materializeManagedResources(tx, principal, existing, modKey);
          const [reconciled] = await tx.update(modInstallations).set({
            ...(input.resolvedVersion ? { resolvedVersion: input.resolvedVersion } : {}),
            updatedByUserId: ctx.userId,
            updatedAt: new Date(),
          }).where(combineWithWritableScope(principal, installationScope, eq(modInstallations.id, existing.id))).returning();
          log.debug("mod install replay: active resources reconciled", { accountId: ctx.accountId, modKey });
          return reconciled ?? existing;
        }

        // Transition to `installing` (create or reuse the durable row).
        const [installing] = await tx
          .insert(modInstallations)
          .values({
            modKey,
            status: "installing",
            resolvedVersion: input.resolvedVersion ?? null,
            installedByUserId: ctx.userId,
            failureCode: null,
            failureDetail: null,
            ...ownedInsertValues(principal, installationScope),
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          })
          .onConflictDoUpdate({
            target: [modInstallations.accountId, modInstallations.modKey],
            set: {
              status: "installing",
              installedByUserId: ctx.userId,
              failureCode: null,
              failureDetail: null,
              updatedByUserId: ctx.userId,
              updatedAt: now,
            },
          })
          .returning();
        if (!installing) throw new ModPlatformError("install_upsert_failed", "Installation upsert failed", 500);

        // Materialize or adopt managed contributions before activation.
        await this.materializeManagedResources(tx, principal, installing, modKey);

        // Transition to `active` only after required local writes succeed.
        const [active] = await tx
          .update(modInstallations)
          .set({
            status: "active",
            activatedAt: installing.activatedAt ?? now,
            disabledAt: null,
            failureCode: null,
            failureDetail: null,
            ...(input.resolvedVersion ? { resolvedVersion: input.resolvedVersion } : {}),
            updatedByUserId: ctx.userId,
            updatedAt: new Date(),
          })
          .where(combineWithWritableScope(principal, installationScope, eq(modInstallations.id, installing.id)))
          .returning();
        if (!active) throw new ModPlatformError("install_activate_failed", "Installation activation failed", 500);
        log.info("mod installed", { accountId: ctx.accountId, modKey, resolvedVersion: active.resolvedVersion });
        return active;
      }),
    );
  }

  /**
   * Disable (uninstall) a Mod. Non-destructive: the row is retained as durable,
   * replayable state. Idempotent when already disabled.
   */
  async disable(principal: Principal, input: DisableInput): Promise<ModInstallationRow> {
    this.assertEnabled();
    this.assertManageAuthority(principal);
    const ctx = this.requireAccountContext(principal);
    const modKey = this.normalizeModKey(input.modKey);

    return db.transaction((tx) =>
      runWithDatabaseTransaction(tx, async () => {
        await acquireAdvisoryTransactionLock(
          tx,
          ADVISORY_LOCK_NS.MOD_LIFECYCLE,
          this.lockKey(ctx.accountId, modKey),
        );
        const [existing] = await tx
          .select()
          .from(modInstallations)
          .where(combineWithWritableScope(principal, installationScope, eq(modInstallations.modKey, modKey)))
          .limit(1);
        if (!existing) {
          throw new ModPlatformError("installation_not_found", `Mod is not installed: ${modKey}`, 404);
        }
        if (existing.status === "disabled") {
          await this.detachManagedResources(tx, principal, existing);
          log.debug("mod disable replay: resources confirmed disabled", { accountId: ctx.accountId, modKey });
          return existing;
        }

        const now = new Date();
        // Any non-active state immediately removes availability; mark `disabling`.
        await tx
          .update(modInstallations)
          .set({ status: "disabling", updatedByUserId: ctx.userId, updatedAt: now })
          .where(combineWithWritableScope(principal, installationScope, eq(modInstallations.id, existing.id)));

        await this.detachManagedResources(tx, principal, existing);

        const [disabled] = await tx
          .update(modInstallations)
          .set({
            status: "disabled",
            disabledAt: new Date(),
            updatedByUserId: ctx.userId,
            updatedAt: new Date(),
          })
          .where(combineWithWritableScope(principal, installationScope, eq(modInstallations.id, existing.id)))
          .returning();
        if (!disabled) throw new ModPlatformError("install_disable_failed", "Installation disable failed", 500);
        log.info("mod disabled", { accountId: ctx.accountId, modKey });
        return disabled;
      }),
    );
  }

  /**
   * Reinstall reconciles retained materializations and data instead of cloning.
   * Because `install` upserts the durable per-(account, Mod) row and reuses
   * retained resources, reinstall re-enters that same idempotent path.
   */
  async reinstall(principal: Principal, input: InstallInput): Promise<ModInstallationRow> {
    log.info("mod reinstall requested", { modKey: input.modKey });
    return this.install(principal, input);
  }

  /**
   * Reconcile a possibly-interrupted installation to a terminal-safe state.
   * Bounded and idempotent: `installing` converges to `active` (still entitled)
   * or `error`; `disabling` converges to `disabled`; other states are returned
   * unchanged.
   */
  async reconcile(principal: Principal, input: DisableInput): Promise<ModInstallationRow | null> {
    this.assertEnabled();
    this.assertManageAuthority(principal);
    const ctx = this.requireAccountContext(principal);
    const modKey = this.normalizeModKey(input.modKey);

    return db.transaction((tx) =>
      runWithDatabaseTransaction(tx, async () => {
        await acquireAdvisoryTransactionLock(
          tx,
          ADVISORY_LOCK_NS.MOD_LIFECYCLE,
          this.lockKey(ctx.accountId, modKey),
        );
        const [existing] = await tx
          .select()
          .from(modInstallations)
          .where(combineWithWritableScope(principal, installationScope, eq(modInstallations.modKey, modKey)))
          .limit(1);
        if (!existing) return null;

        const now = new Date();
        if (existing.status === "installing") {
          const [entitlement] = await tx
            .select()
            .from(modEntitlements)
            .where(combineWithVisibleScope(principal, entitlementScope, eq(modEntitlements.modKey, modKey)))
            .limit(1);
          if (this.entitlementIsActive(entitlement, now)) {
            await this.materializeManagedResources(tx, principal, existing, modKey);
            const [active] = await tx
              .update(modInstallations)
              .set({
                status: "active",
                activatedAt: existing.activatedAt ?? now,
                failureCode: null,
                failureDetail: null,
                updatedByUserId: ctx.userId,
                updatedAt: new Date(),
              })
              .where(
                combineWithWritableScope(
                  principal,
                  installationScope,
                  and(eq(modInstallations.id, existing.id), eq(modInstallations.status, "installing")),
                ),
              )
              .returning();
            log.info("mod reconcile: installing → active", { accountId: ctx.accountId, modKey });
            return active ?? existing;
          }
          const [errored] = await tx
            .update(modInstallations)
            .set({
              status: "error",
              failureCode: "entitlement_missing",
              failureDetail: "Reconcile found no active entitlement for an installing Mod",
              updatedByUserId: ctx.userId,
              updatedAt: new Date(),
            })
            .where(
              combineWithWritableScope(
                principal,
                installationScope,
                and(eq(modInstallations.id, existing.id), eq(modInstallations.status, "installing")),
              ),
            )
            .returning();
          log.warn("mod reconcile: installing → error (no entitlement)", { accountId: ctx.accountId, modKey });
          return errored ?? existing;
        }

        if (existing.status === "disabling") {
          await this.detachManagedResources(tx, principal, existing);
          const [disabled] = await tx
            .update(modInstallations)
            .set({
              status: "disabled",
              disabledAt: existing.disabledAt ?? now,
              updatedByUserId: ctx.userId,
              updatedAt: new Date(),
            })
            .where(
              combineWithWritableScope(
                principal,
                installationScope,
                and(eq(modInstallations.id, existing.id), eq(modInstallations.status, "disabling")),
              ),
            )
            .returning();
          log.info("mod reconcile: disabling → disabled", { accountId: ctx.accountId, modKey });
          return disabled ?? existing;
        }

        return existing;
      }),
    );
  }
  /**
   * Install a first-party Mod from the ADMIN → Mods surface. First-party Mods
   * are product-entitled by default, so this grants the product entitlement
   * under mods:manage and then drives the canonical install state machine.
   */
  async installProductMod(principal: Principal, modKey: string): Promise<ModInstallationRow> {
    this.assertEnabled();
    this.assertManageAuthority(principal);
    const key = this.normalizeModKey(modKey);
    await this.grantBaselineEntitlement(principal, key);
    return this.install(principal, { modKey: key });
  }

  /** Grant a baseline product entitlement under mods:manage (not commercial system:write). */
  private async grantBaselineEntitlement(principal: Principal, modKey: ModKey): Promise<void> {
    const ctx = this.requireAccountContext(principal);
    await db.transaction((tx) =>
      runWithDatabaseTransaction(tx, async () => {
        await acquireAdvisoryTransactionLock(
          tx,
          ADVISORY_LOCK_NS.MOD_LIFECYCLE,
          this.lockKey(ctx.accountId, modKey),
        );
        await tx
          .insert(modEntitlements)
          .values({
            modKey,
            status: "granted",
            sourceType: "baseline",
            sourceId: "default",
            ...ownedInsertValues(principal, entitlementScope),
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          })
          .onConflictDoUpdate({
            target: [modEntitlements.accountId, modEntitlements.modKey],
            set: { status: "granted", updatedByUserId: ctx.userId, updatedAt: new Date() },
          });
      }),
    );
  }

  /**
   * Read the account's installation + entitlement state for every Mod key.
   * Read-only and principal-scoped. Callers join this with the code-owned
   * registry to project the customer-facing catalog.
   */
  async listAccountState(
    principal: Principal,
  ): Promise<{ entitlements: ModEntitlementRow[]; installations: ModInstallationRow[] }> {
    this.assertEnabled();
    this.requireAccountContext(principal);
    if (!principalHasPermission(principal, "mods:read")) {
      throw new ModPlatformError("mods_read_required", "mods:read permission required", 403);
    }
    const [entitlements, installations] = await Promise.all([
      db
        .select()
        .from(modEntitlements)
        .where(combineWithVisibleScope(principal, entitlementScope))
        .limit(100),
      db
        .select()
        .from(modInstallations)
        .where(combineWithVisibleScope(principal, installationScope))
        .limit(100),
    ]);
    return { entitlements, installations };
  }

  /**
   * Universally install Build for accounts that have never made an explicit
   * Build lifecycle choice. Existing disabled rows remain disabled. This grants
   * only product entitlement/installation state; permissions and provider
   * credentials remain independent authorities.
   */
  async ensureBuildInstalled(principal: Principal): Promise<void> {
    this.assertEnabled();
    this.requireAccountContext(principal);
    if (!principalHasPermission(principal, "mods:manage")) return;
    const [existing] = await db.select({ id: modInstallations.id, status: modInstallations.status })
      .from(modInstallations)
      .where(combineWithWritableScope(principal, installationScope, eq(modInstallations.modKey, "build")))
      .limit(1);
    if (existing?.status === "disabled" || existing?.status === "disabling") return;
    await this.grantBaselineEntitlement(principal, "build");
    await this.install(principal, { modKey: "build", resolvedVersion: "1.0.0" });
  }

  /**
   * Universally install Wellness for accounts that have never made an explicit
   * Wellness lifecycle choice, mirroring ensureBuildInstalled. Wellness is a
   * gated default product (its /api/wellness surface is server-enforced), so —
   * like Build — it needs a guaranteed install on login rather than
   * baseline-only provisioning. Existing disabled rows remain disabled so a
   * later owner disable is durable and never silently re-enabled.
   */
  async ensureWellnessInstalled(principal: Principal): Promise<void> {
    this.assertEnabled();
    this.requireAccountContext(principal);
    if (!principalHasPermission(principal, "mods:manage")) return;
    const [existing] = await db.select({ id: modInstallations.id, status: modInstallations.status })
      .from(modInstallations)
      .where(combineWithWritableScope(principal, installationScope, eq(modInstallations.modKey, "wellness")))
      .limit(1);
    if (existing?.status === "disabled" || existing?.status === "disabling") return;
    await this.grantBaselineEntitlement(principal, "wellness");
    await this.install(principal, { modKey: "wellness" });
  }

  /**
   * Idempotently provision the baseline (Planning + Network) as active
   * installations. A default is a bootstrap, not a lock: a Mod that already has
   * ANY installation row (including an explicit `disabled`) is left untouched,
   * so a later owner disable is durable and never silently re-enabled.
   */
  async ensureBaseline(principal: Principal): Promise<void> {
    this.assertEnabled();
    this.requireAccountContext(principal);
    if (!principalHasPermission(principal, "mods:manage")) return; // read-only viewers skip bootstrap
    for (const modKey of BASELINE_MOD_KEYS) {
      const [existing] = await db
        .select({ id: modInstallations.id })
        .from(modInstallations)
        .where(combineWithWritableScope(principal, installationScope, eq(modInstallations.modKey, modKey)))
        .limit(1);
      if (existing) continue;
      await this.grantBaselineEntitlement(principal, modKey);
      await this.install(principal, { modKey });
    }
  }
}

export const modLifecycleService = new ModLifecycleService();
