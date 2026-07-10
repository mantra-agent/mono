import { db } from "../db";
import { objectAcls } from "@shared/schema";
import { eq } from "drizzle-orm";
import type { Principal } from "../principal";

export enum ObjectAccessGroupType {
  USER_LIST = "USER_LIST",
  EMAIL_DOMAIN = "EMAIL_DOMAIN",
  GROUP_MEMBER = "GROUP_MEMBER",
  SUBSCRIBER = "SUBSCRIBER",
}

export interface ObjectAccessGroup {
  type: ObjectAccessGroupType;
  id: string;
}

export enum ObjectPermission {
  READ = "read",
  WRITE = "write",
}

export interface ObjectAclRule {
  group: ObjectAccessGroup;
  permission: ObjectPermission;
}

// The ACL policy of the object.
// Stored in the `object_acls` table keyed by the S3 object key.
export interface ObjectAclPolicy {
  owner: string;
  visibility: "public" | "private";
  scope?: "user" | "account" | "system" | "public";
  ownerUserId?: string | null;
  accountId?: string | null;
  createdByUserId?: string | null;
  vaultId?: string;
  aclRules?: Array<ObjectAclRule>;
}

// Check if the requested permission is allowed based on the granted permission.
function isPermissionAllowed(
  requested: ObjectPermission,
  granted: ObjectPermission,
): boolean {
  // Users granted with read or write permissions can read the object.
  if (requested === ObjectPermission.READ) {
    return [ObjectPermission.READ, ObjectPermission.WRITE].includes(granted);
  }

  // Only users granted with write permissions can write the object.
  return granted === ObjectPermission.WRITE;
}

abstract class BaseObjectAccessGroup implements ObjectAccessGroup {
  constructor(
    public readonly type: ObjectAccessGroupType,
    public readonly id: string,
  ) {}

  // Check if the user is a member of the group.
  public abstract hasMember(userId: string): Promise<boolean>;
}

function createObjectAccessGroup(
  group: ObjectAccessGroup,
): BaseObjectAccessGroup {
  switch (group.type) {
    default:
      throw new Error(`Unknown access group type: ${group.type}`);
  }
}

// Sets the ACL policy for an object key in the database.
export async function setObjectAclPolicy(
  objectKey: string,
  aclPolicy: ObjectAclPolicy,
): Promise<void> {
  if (!objectKey) throw new Error("Object key is required");
  const now = new Date();
  await db
    .insert(objectAcls)
    .values({
      objectKey,
      policy: aclPolicy,
      vaultId: aclPolicy.vaultId ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: objectAcls.objectKey,
      set: {
        policy: aclPolicy,
        vaultId: aclPolicy.vaultId ?? null,
        updatedAt: now,
      },
    });
}

// Gets the ACL policy for an object key from the database.
export async function getObjectAclPolicy(
  objectKey: string,
): Promise<ObjectAclPolicy | null> {
  if (!objectKey) return null;
  const rows = await db
    .select()
    .from(objectAcls)
    .where(eq(objectAcls.objectKey, objectKey))
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0].policy as ObjectAclPolicy;
}

// Deletes the ACL policy for an object key.
export async function deleteObjectAclPolicy(objectKey: string): Promise<void> {
  if (!objectKey) return;
  await db.delete(objectAcls).where(eq(objectAcls.objectKey, objectKey));
}


function principalCanAccessPolicy(
  principal: Principal | null | undefined,
  aclPolicy: ObjectAclPolicy,
  requestedPermission: ObjectPermission,
): boolean {
  if (aclPolicy.visibility === "public" && requestedPermission === ObjectPermission.READ) {
    return true;
  }
  if (!principal) return false;
  if (principal.actorType === "system" || principal.isAdmin) return true;

  const principalUserId = principal.userId ?? undefined;
  const principalAccountId = principal.accountId ?? undefined;
  const ownerUserId = aclPolicy.ownerUserId ?? aclPolicy.owner;

  if (principalUserId && ownerUserId === principalUserId) return true;
  if (principalAccountId && aclPolicy.accountId === principalAccountId) return true;
  return false;
}

export async function canAccessObjectForPrincipal({
  principal,
  objectKey,
  requestedPermission,
}: {
  principal: Principal | null | undefined;
  objectKey: string;
  requestedPermission: ObjectPermission;
}): Promise<boolean> {
  const aclPolicy = await getObjectAclPolicy(objectKey);
  if (!aclPolicy) return false;
  if (principalCanAccessPolicy(principal, aclPolicy, requestedPermission)) return true;

  const userId = principal?.userId ?? undefined;
  if (!userId) return false;
  for (const rule of aclPolicy.aclRules || []) {
    const accessGroup = createObjectAccessGroup(rule.group);
    if ((await accessGroup.hasMember(userId)) && isPermissionAllowed(requestedPermission, rule.permission)) {
      return true;
    }
  }
  return false;
}

// Checks if the user can access the object identified by its key.
export async function canAccessObject({
  userId,
  objectKey,
  requestedPermission,
}: {
  userId?: string;
  objectKey: string;
  requestedPermission: ObjectPermission;
}): Promise<boolean> {
  // When this function is called, the acl policy is required.
  const aclPolicy = await getObjectAclPolicy(objectKey);
  if (!aclPolicy) {
    return false;
  }

  // Public objects are always accessible for read.
  if (
    aclPolicy.visibility === "public" &&
    requestedPermission === ObjectPermission.READ
  ) {
    return true;
  }

  // Access control requires the user id.
  if (!userId) {
    return false;
  }

  // The owner of the object can always access it.
  if (aclPolicy.owner === userId) {
    return true;
  }

  // Go through the ACL rules to check if the user has the required permission.
  for (const rule of aclPolicy.aclRules || []) {
    const accessGroup = createObjectAccessGroup(rule.group);
    if (
      (await accessGroup.hasMember(userId)) &&
      isPermissionAllowed(requestedPermission, rule.permission)
    ) {
      return true;
    }
  }

  return false;
}
