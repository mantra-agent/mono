import { peopleStorage } from "./people-storage";
import { documentStorage } from "./memory";
import { getInstanceNameLower } from "@shared/instance-config";

function parseUserName(userMdContent: string): string {
  const callMatch = userMdContent.match(/\*\*What to call them:\*\*\s*(.+)/);
  if (callMatch) return callMatch[1].trim();
  const nameMatch = userMdContent.match(/\*\*Name:\*\*\s*(.+)/);
  if (nameMatch) return nameMatch[1].trim();
  return "the user";
}

let cachedUserName: string | null = null;

export async function getUserName(): Promise<string> {
  if (cachedUserName) return cachedUserName;
  try {
    const allPeople = await peopleStorage.listPeople();
    // Look for the user person (new "user" level), fallback to legacy "self" non-agent
    let partner = allPeople.find(p => p.cabinetLevel === "user");
    if (!partner) {
      const selfPeople = allPeople.filter(p => p.cabinetLevel === "self");
      partner = selfPeople.find(p => p.name.toLowerCase() !== getInstanceNameLower());
    }
    if (partner) {
      cachedUserName = partner.nicknames?.[0] || partner.name;
      return cachedUserName;
    }
  } catch { /* fall through */ }
  try {
    const userDoc = await documentStorage.getDocument("identity", "user");
    cachedUserName = parseUserName(userDoc?.content || "");
  } catch {
    cachedUserName = "the user";
  }
  return cachedUserName;
}

export function clearUserNameCache() {
  cachedUserName = null;
}
