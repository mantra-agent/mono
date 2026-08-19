import {
  decrypt,
  encrypt,
  getEncryptionKey,
  getPreviousEncryptionKey,
  isEncryptedEnvelope,
} from "./encryption";
import { getSetting, setSetting } from "./system-settings";

const SETTING_KEY = "system.automation_auth_token";
const USER_SETTING_KEY = "system.automation_auth_user_id";
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getAutomationAuthToken(): Promise<string | null> {
  const stored = await getSetting<unknown>(SETTING_KEY);
  if (typeof stored === "string") {
    await setAutomationAuthToken(stored);
    return stored;
  }
  if (!isEncryptedEnvelope(stored)) return null;
  try {
    return await decrypt(stored, getEncryptionKey());
  } catch {
    const previous = getPreviousEncryptionKey();
    if (!previous) return null;
    const token = await decrypt(stored, previous);
    await setAutomationAuthToken(token);
    return token;
  }
}

export async function setAutomationAuthToken(token: string): Promise<void> {
  if (token.length < 32)
    throw new Error("Automation token must be at least 32 characters");
  await setSetting(SETTING_KEY, await encrypt(token, getEncryptionKey()));
}

export async function getAutomationAuthBoundUserId(): Promise<string | null> {
  const stored = await getSetting<unknown>(USER_SETTING_KEY);
  if (typeof stored !== "string") return null;
  const trimmed = stored.trim();
  return USER_ID_RE.test(trimmed) ? trimmed : null;
}

export async function setAutomationAuthBoundUserId(userId: string | null): Promise<void> {
  if (userId === null) {
    const { deleteSetting } = await import("./system-settings");
    await deleteSetting(USER_SETTING_KEY);
    return;
  }
  const trimmed = userId.trim();
  if (!USER_ID_RE.test(trimmed)) {
    throw new Error("Automation bound user must be a user UUID");
  }
  await setSetting(USER_SETTING_KEY, trimmed);
}
