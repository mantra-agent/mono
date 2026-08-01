// Central named-permission vocabulary — single source of truth for the
// authorization contract. Kept dependency-free so client code, server code,
// and build-time tooling (e.g. Mod registry validation) can all import the
// canonical permission strings without pulling the database boundary.
//
// server/permissions.ts re-exports these and owns effective-permission lookup,
// route middleware, and the user_permissions schema. Do not fork this list.
export const PERMISSIONS = [
  "build:read",
  "build:write",
  "system:read",
  "system:write",
  "users:read",
  "users:write",
  "mods:read",
  "mods:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
