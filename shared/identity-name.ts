export interface UserIdentityNameInput {
  preferredName?: string | null;
  displayName?: string | null;
  email?: string | null;
}

function cleanIdentityName(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function formatEmailLocalPart(email: string | null | undefined): string | null {
  const localPart = cleanIdentityName(email)?.split("@", 1)[0]
    ?.replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!localPart) return null;
  return localPart
    .split(" ")
    .map((part) => part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

/**
 * Canonical first-name derivation for account identity, Personal Vault naming,
 * and user-facing greetings. Profile identity wins; email is a bounded fallback.
 */
export function deriveUserFirstName(
  input: UserIdentityNameInput,
  fallback = "there",
): string {
  const profileName = cleanIdentityName(input.preferredName)
    ?? cleanIdentityName(input.displayName);
  const source = profileName && !profileName.includes("@")
    ? profileName
    : formatEmailLocalPart(input.email);
  return source?.split(/\s+/, 1)[0] || fallback;
}

/**
 * Canonical avatar initials: first letter of first + last name when available.
 * Prefer display name (usually full), then preferred name, then email local-part.
 * Single-token names use the first two letters of that token; empty falls back to "?".
 */
export function deriveUserInitials(input: UserIdentityNameInput): string {
  const profileName = cleanIdentityName(input.displayName)
    ?? cleanIdentityName(input.preferredName);
  const source = profileName && !profileName.includes("@")
    ? profileName
    : formatEmailLocalPart(input.email);
  if (!source) return "?";

  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0]?.charAt(0) ?? "";
    const last = parts[parts.length - 1]?.charAt(0) ?? "";
    const initials = `${first}${last}`.toUpperCase();
    return initials || "?";
  }

  const single = parts[0] ?? "";
  if (single.length >= 2) return single.slice(0, 2).toUpperCase();
  if (single.length === 1) return single.toUpperCase();
  return "?";
}
