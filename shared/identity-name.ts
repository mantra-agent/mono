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
