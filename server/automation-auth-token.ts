import {
  decrypt,
  encrypt,
  getEncryptionKey,
  getPreviousEncryptionKey,
  isEncryptedEnvelope,
} from "./encryption";
import { getSetting, setSetting } from "./system-settings";

const SETTING_KEY = "system.automation_auth_token";

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
