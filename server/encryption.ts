import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "crypto";
import { promisify } from "util";
import { createLogger } from "./log";

const log = createLogger("Encryption");

// Async scrypt — Task #995. The blocking variant is intentionally CPU-
// expensive (50-150ms) and made every credential encrypt/decrypt freeze the
// event loop. Promisified scrypt runs on libuv's thread pool and never
// stalls the main thread.
const scryptAsync = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const ENVELOPE_VERSION = 1;

interface EncryptedEnvelope {
  v: number;
  salt: string;
  iv: string;
  ct: string;
  tag: string;
}

async function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(secret, salt, KEY_LENGTH);
}

export async function encrypt(plaintext: string, secret: string): Promise<EncryptedEnvelope> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(secret, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: ENVELOPE_VERSION,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: encrypted.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export async function decrypt(envelope: EncryptedEnvelope, secret: string): Promise<string> {
  const salt = Buffer.from(envelope.salt, "base64");
  const key = await deriveKey(secret, salt);
  const iv = Buffer.from(envelope.iv, "base64");
  const ct = Buffer.from(envelope.ct, "base64");
  const tag = Buffer.from(envelope.tag, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
  return decrypted.toString("utf8");
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.v === ENVELOPE_VERSION &&
    typeof obj.salt === "string" &&
    typeof obj.iv === "string" &&
    typeof obj.ct === "string" &&
    typeof obj.tag === "string"
  );
}

export async function encryptJson(data: unknown, secret: string): Promise<EncryptedEnvelope> {
  return encrypt(JSON.stringify(data), secret);
}

export async function decryptJson(envelope: EncryptedEnvelope, secret: string): Promise<unknown> {
  const plaintext = await decrypt(envelope, secret);
  return JSON.parse(plaintext);
}

let _currentKey: string | null = null;
let _previousKey: string | null = null;

export function loadEncryptionKeys(): { current: string; previous: string | null } {
  _currentKey = process.env.ENCRYPTION_KEY || null;
  _previousKey = process.env.ENCRYPTION_KEY_PREVIOUS || null;

  if (!_currentKey) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is required. " +
      "All provider credentials are encrypted at rest — set this secret before starting the server."
    );
  }

  return { current: _currentKey, previous: _previousKey };
}

export function getEncryptionKey(): string {
  if (!_currentKey) {
    throw new Error("ENCRYPTION_KEY not loaded — call loadEncryptionKeys() at startup");
  }
  return _currentKey;
}

export function getPreviousEncryptionKey(): string | null {
  return _previousKey;
}

export async function encryptTokens(tokens: unknown): Promise<unknown> {
  const key = getEncryptionKey();
  return encryptJson(tokens, key);
}

export async function decryptTokens(stored: unknown): Promise<{ data: unknown; wasRotated: boolean }> {
  if (!stored) return { data: stored, wasRotated: false };
  if (!isEncryptedEnvelope(stored)) return { data: stored, wasRotated: false };

  const currentKey = getEncryptionKey();
  if (currentKey) {
    try {
      return { data: await decryptJson(stored, currentKey), wasRotated: false };
    } catch {
    }
  }

  const prevKey = getPreviousEncryptionKey();
  if (prevKey) {
    try {
      return { data: await decryptJson(stored, prevKey), wasRotated: true };
    } catch {
    }
  }

  log.error("Failed to decrypt tokens — neither current nor previous key worked");
  return { data: null, wasRotated: false };
}

export function needsEncryption(stored: unknown): boolean {
  if (!stored) return false;
  if (isEncryptedEnvelope(stored)) return false;
  return true;
}
