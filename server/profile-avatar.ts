import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { userProfiles } from "@shared/schema";
import type { Principal } from "./principal";
import { ADVISORY_LOCK_NS, acquireAdvisoryTransactionLock, db } from "./db";
import { storageBackend, PRIVATE_PREFIX } from "./object_storage";
import { deleteObjectAclPolicy, setObjectAclPolicy } from "./object_storage/objectAcl";
import { createLogger } from "./log";

const log = createLogger("ProfileAvatar");
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 16_000_000;

interface AvatarMetadata {
  avatarObjectPath?: string;
}

interface VerifiedImage {
  extension: "jpg" | "png" | "webp";
  contentType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
}

export async function getAvatarObjectPath(principal: Principal): Promise<string | null> {
  if (!principal.userId || !principal.accountId) return null;
  const [profile] = await db.select({ metadata: userProfiles.metadata })
    .from(userProfiles)
    .where(and(eq(userProfiles.userId, principal.userId), eq(userProfiles.accountId, principal.accountId)))
    .limit(1);
  const value = (profile?.metadata as AvatarMetadata | undefined)?.avatarObjectPath;
  return typeof value === "string" && value.startsWith("/objects/profile-pictures/") ? value : null;
}

export async function replaceProfileAvatar(
  principal: Principal,
  bytes: Buffer,
  declaredMime: string,
): Promise<string> {
  if (!principal.userId || !principal.accountId) throw new Error("User principal required");
  const image = verifyImage(bytes, declaredMime);
  const filename = `${randomUUID()}.${image.extension}`;
  const objectPath = `/objects/profile-pictures/${filename}`;
  const objectKey = `${PRIVATE_PREFIX}profile-pictures/${filename}`;

  await storageBackend.putObject(objectKey, bytes, { contentType: image.contentType, cacheControl: "private, max-age=31536000, immutable" });
  await setObjectAclPolicy(objectKey, {
    owner: principal.userId,
    ownerUserId: principal.userId,
    accountId: principal.accountId,
    createdByUserId: principal.userId,
    scope: "user",
    visibility: "private",
  });
  const stored = await storageBackend.headObject(objectKey);
  if (!stored || stored.contentLength !== bytes.length) {
    await cleanupObject(objectKey);
    throw new Error("Avatar write verification failed");
  }

  let previousPath: string | null = null;
  try {
    await db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.PROFILE_AVATAR, `${principal.accountId}:${principal.userId}`);
      const [profile] = await tx.select({ metadata: userProfiles.metadata })
        .from(userProfiles)
        .where(and(eq(userProfiles.userId, principal.userId!), eq(userProfiles.accountId, principal.accountId!)))
        .limit(1);
      if (!profile) throw new Error("User profile not found");
      const metadata = (profile.metadata && typeof profile.metadata === "object" ? profile.metadata : {}) as Record<string, unknown>;
      previousPath = typeof metadata.avatarObjectPath === "string" ? metadata.avatarObjectPath : null;
      await tx.update(userProfiles)
        .set({ metadata: { ...metadata, avatarObjectPath: objectPath }, updatedAt: new Date() })
        .where(and(eq(userProfiles.userId, principal.userId!), eq(userProfiles.accountId, principal.accountId!)));
    });
  } catch (error) {
    await cleanupObject(objectKey);
    throw error;
  }

  if (previousPath && previousPath !== objectPath) {
    const previousKey = objectKeyFromPath(previousPath);
    if (previousKey) cleanupObject(previousKey).catch((error) => log.warn("Prior avatar cleanup failed", { errorType: error instanceof Error ? error.name : typeof error }));
  }
  log.info("Profile avatar replaced", { byteCount: bytes.length, width: image.width, height: image.height, contentType: image.contentType });
  return objectPath;
}

function objectKeyFromPath(path: string): string | null {
  if (!path.startsWith("/objects/profile-pictures/")) return null;
  const filename = path.slice("/objects/profile-pictures/".length);
  return /^[a-f0-9-]+\.(?:jpg|png|webp)$/.test(filename) ? `${PRIVATE_PREFIX}profile-pictures/${filename}` : null;
}

async function cleanupObject(key: string): Promise<void> {
  await storageBackend.deleteObject(key);
  await deleteObjectAclPolicy(key);
}

function verifyImage(bytes: Buffer, declaredMime: string): VerifiedImage {
  let image: VerifiedImage | null = null;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    image = { extension: "png", contentType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (bytes.length >= 30 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    image = parseJpeg(bytes);
  } else if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    image = parseWebp(bytes);
  }
  if (!image || image.contentType !== declaredMime) throw new Error("File content does not match an allowed image type");
  if (image.width < 1 || image.height < 1 || image.width > MAX_DIMENSION || image.height > MAX_DIMENSION || image.width * image.height > MAX_PIXELS) {
    throw new Error("Image dimensions exceed the allowed limit");
  }
  return image;
}

function parseJpeg(bytes: Buffer): VerifiedImage | null {
  let offset = 2;
  let segments = 0;
  while (offset + 4 <= bytes.length && segments++ < 512) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null;
      return { extension: "jpg", contentType: "image/jpeg", height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function parseWebp(bytes: Buffer): VerifiedImage | null {
  const kind = bytes.toString("ascii", 12, 16);
  if (kind === "VP8X" && bytes.length >= 30) {
    return { extension: "webp", contentType: "image/webp", width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { extension: "webp", contentType: "image/webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { extension: "webp", contentType: "image/webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return null;
}
