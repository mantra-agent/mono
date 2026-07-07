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

export { registerObjectStorageRoutes } from "./routes";
