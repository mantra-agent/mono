export {
  ObjectStorageService,
  ObjectNotFoundError,
  StorageObjectRef,
  objectStorageService,
  storageBackend,
  PUBLIC_PREFIX,
  PRIVATE_PREFIX,
} from "./objectStorage";

export type {
  ObjectAclPolicy,
  ObjectAccessGroup,
  ObjectAclRule,
} from "./objectAcl";

export {
  ObjectAccessGroupType,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
  deleteObjectAclPolicy,
} from "./objectAcl";

export {
  vaultObjectKey,
  vaultObjectKeyFromPrincipal,
  vaultObjectKeyAuto,
  isVaultKey,
  isLegacyKey,
  legacyKeyToVaultKey,
  vaultKeyToLegacyKey,
  extractEntityPath,
  resolveObjectKeyWithFallback,
  VAULT_PREFIX,
} from "./vault-keys";

export { registerObjectStorageRoutes } from "./routes";
