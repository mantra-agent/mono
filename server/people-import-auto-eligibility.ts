/**
 * Pure high-confidence auto-import policy (v1).
 * Candidate + matches → decisive action. No I/O.
 */
import {
  isSyntheticContactEmail,
  type StoredImportCandidate,
} from "./import-queue";
import type { ImportMatch } from "./people-import-decision-service";

export const PEOPLE_IMPORT_AUTO_POLICY_VERSION = "v1";

export type AutoImportAction = "merge" | "add" | "skip" | "leave_queued";

export type AutoImportReason =
  | "auto:merge:exact_email"
  | "auto:merge:exact_phone"
  | "auto:merge:linked_person"
  | "auto:add:clear_identity"
  | "auto:skip:self"
  | "auto:skip:junk_pattern"
  | "auto:skip:opt_out"
  | "auto:skip:empty_identity"
  | "auto:leave:ambiguous"
  | "auto:leave:source_disabled"
  | "auto:leave:no_interaction"
  | "auto:leave:incomplete_identity";

export interface AutoEligibilityInput {
  candidate: StoredImportCandidate;
  matches: ImportMatch[];
  /** Normalized principal / connected-account emails for self detection. */
  principalEmails?: string[];
  /** Normalized principal phones for self detection. */
  principalPhones?: string[];
}

export interface AutoEligibilityDecision {
  action: AutoImportAction;
  reason: AutoImportReason;
  personId?: string;
  policyVersion: typeof PEOPLE_IMPORT_AUTO_POLICY_VERSION;
}

/** Day-one auto sources. iOS stays judgment-only. */
const DAY_ONE_AUTO_SOURCES = new Set([
  "email",
  "email_sync",
  "email_triage",
  "gmail",
  "gmail_scan",
  "people_signal",
  "calendar",
  "calendar_attendee",
  "meeting",
]);

const JUNK_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "notifications",
  "notification",
  "mailer-daemon",
  "billing",
  "invoice",
  "receipts",
  "orders",
  "shipment",
  "news",
  "newsletter",
  "marketing",
  "updates",
  "alert",
  "alerts",
  "support",
  "help",
  "info",
  "hello",
  "contact",
  "admin",
  "postmaster",
  "bounce",
  "bounces",
  "daemon",
  "automail",
  "auto-confirm",
  "autoconfirm",
  "subscribe",
  "unsubscribe",
  "feedback",
  "service",
  "services",
  "system",
  "robot",
  "bot",
]);

const JUNK_DOMAIN_SUFFIXES = [
  "facebookmail.com",
  "linkedin.com",
  "lnkd.in",
  "mail.instagram.com",
  "email.apple.com",
  "amazonses.com",
  "sendgrid.net",
  "mailchimp.com",
  "mandrillapp.com",
  "intercom-mail.com",
  "intercom.io",
  "stripe.com",
  "paypal.com",
  "squareup.com",
  "github.com",
  "noreply.github.com",
  "google.com",
  "accounts.google.com",
  "apple.com",
];

const OPT_OUT_PATTERN =
  /\b(stop|unsubscribe|opt[-\s]?out|remove me|leave me out|no thanks|do not contact|don't contact|take me off)\b/i;

const HIGH_MATCH_REASONS = new Set(["exact_email", "exact_phone", "linked_person"]);

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string): string {
  return value.replace(/[^+\d]/g, "");
}

function leave(reason: AutoImportReason): AutoEligibilityDecision {
  return { action: "leave_queued", reason, policyVersion: PEOPLE_IMPORT_AUTO_POLICY_VERSION };
}

function isDayOneAutoSource(source: string | undefined): boolean {
  if (!source || !source.trim()) {
    // Email staging historically omitted source; treat bare email path as day-one.
    return true;
  }
  const normalized = source.trim().toLowerCase();
  if (normalized === "ios_contacts" || normalized.startsWith("ios")) return false;
  if (DAY_ONE_AUTO_SOURCES.has(normalized)) return true;
  if (normalized.includes("email") || normalized.includes("gmail")) return true;
  if (normalized.includes("calendar") || normalized.includes("meeting")) return true;
  return false;
}

function isCalendarSource(source: string | undefined): boolean {
  const normalized = (source || "").trim().toLowerCase();
  return normalized.includes("calendar") || normalized.includes("meeting");
}

function candidateEmails(candidate: StoredImportCandidate): string[] {
  const values = new Set<string>();
  if (candidate.email && !isSyntheticContactEmail(candidate.email)) {
    values.add(normalizeEmail(candidate.email));
  }
  for (const email of candidate.emails || []) {
    if (email && !isSyntheticContactEmail(email)) values.add(normalizeEmail(email));
  }
  for (const contact of candidate.contactInfo || []) {
    if (contact.type === "email" && contact.value && !isSyntheticContactEmail(contact.value)) {
      values.add(normalizeEmail(contact.value));
    }
  }
  return [...values];
}

function candidatePhones(candidate: StoredImportCandidate): string[] {
  const values = new Set<string>();
  for (const phone of candidate.phones || []) {
    const normalized = normalizePhone(phone);
    if (normalized) values.add(normalized);
  }
  for (const contact of candidate.contactInfo || []) {
    if (contact.type === "phone" && contact.value) {
      const normalized = normalizePhone(contact.value);
      if (normalized) values.add(normalized);
    }
  }
  return [...values];
}

function personName(candidate: StoredImportCandidate): string {
  return (candidate.displayName || candidate.name || "").trim();
}

function nameIsUsable(candidate: StoredImportCandidate): boolean {
  const name = personName(candidate);
  if (!name) return false;
  const emails = candidateEmails(candidate);
  const localParts = emails.map((email) => email.split("@")[0] || "").filter(Boolean);
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalizedName) return false;
  // Reject names that are only the email local-part / garbage tokens.
  if (localParts.some((local) => local.toLowerCase().replace(/[^a-z0-9]+/g, "") === normalizedName)) {
    return false;
  }
  if (/^(unknown|contact|no.?name|n\/a|none|null|undefined)$/i.test(name)) return false;
  return true;
}

function hasRealContactMethod(candidate: StoredImportCandidate): boolean {
  return candidateEmails(candidate).length > 0 || candidatePhones(candidate).length > 0;
}

function hasInteractionSignal(candidate: StoredImportCandidate): boolean {
  if ((candidate.sentCount || 0) + (candidate.receivedCount || 0) >= 1) return true;
  if ((candidate.threadCount || 0) >= 1) return true;
  if ((candidate.interactions || []).length >= 1) return true;
  // Calendar-staged attendees: event join is the interaction signal.
  if (isCalendarSource(candidate.source)) return true;
  return false;
}

function isSelfCandidate(
  candidate: StoredImportCandidate,
  principalEmails: string[],
  principalPhones: string[],
): boolean {
  const emails = new Set(principalEmails.map(normalizeEmail).filter(Boolean));
  const phones = new Set(principalPhones.map(normalizePhone).filter(Boolean));
  if (candidateEmails(candidate).some((email) => emails.has(email))) return true;
  if (candidatePhones(candidate).some((phone) => phones.has(phone))) return true;
  return false;
}

function localPartLooksJunk(local: string): boolean {
  const normalized = local.toLowerCase();
  if (JUNK_LOCAL_PARTS.has(normalized)) return true;
  if (normalized.includes("noreply") || normalized.includes("no-reply")) return true;
  if (normalized.includes("donotreply") || normalized.includes("do-not-reply")) return true;
  if (normalized.endsWith("-noreply") || normalized.startsWith("noreply")) return true;
  return false;
}

function domainLooksJunk(domain: string): boolean {
  const normalized = domain.toLowerCase();
  return JUNK_DOMAIN_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function isJunkPattern(candidate: StoredImportCandidate): boolean {
  for (const email of candidateEmails(candidate)) {
    const [local = "", domain = ""] = email.split("@");
    if (localPartLooksJunk(local)) return true;
    if (domainLooksJunk(domain) && !nameIsUsable(candidate)) return true;
  }
  // Brand/system mailbox with no personal display name.
  const name = personName(candidate);
  if (!nameIsUsable(candidate) && candidateEmails(candidate).length > 0) {
    const [local = ""] = candidateEmails(candidate)[0]?.split("@") || [];
    if (localPartLooksJunk(local) || /^(info|hello|contact|support|team|sales|admin)$/i.test(local)) {
      return true;
    }
  }
  // Name collapses to a mailbox token.
  if (name && localPartLooksJunk(name.replace(/\s+/g, ""))) return true;
  return false;
}

function hasOptOutEvidence(candidate: StoredImportCandidate): boolean {
  for (const subject of candidate.sampleSubjects || []) {
    if (OPT_OUT_PATTERN.test(subject)) return true;
  }
  for (const interaction of candidate.interactions || []) {
    if (OPT_OUT_PATTERN.test(interaction.subject || "")) return true;
    if (OPT_OUT_PATTERN.test(interaction.snippet || "")) return true;
  }
  return false;
}

function highMatches(matches: ImportMatch[]): ImportMatch[] {
  return matches.filter(
    (match) =>
      match.confidence === "high" &&
      match.reasons.some((reason) => HIGH_MATCH_REASONS.has(reason)),
  );
}

function mergeReason(match: ImportMatch): AutoImportReason {
  if (match.reasons.includes("exact_email")) return "auto:merge:exact_email";
  if (match.reasons.includes("exact_phone")) return "auto:merge:exact_phone";
  return "auto:merge:linked_person";
}

/**
 * Evaluate high-confidence auto policy. First decisive rule wins.
 * Default terminal action: leave_queued.
 */
export function evaluateAutoImportEligibility(input: AutoEligibilityInput): AutoEligibilityDecision {
  const { candidate, matches } = input;
  const principalEmails = input.principalEmails || [];
  const principalPhones = input.principalPhones || [];

  if (!isDayOneAutoSource(candidate.source)) {
    return leave("auto:leave:source_disabled");
  }

  const highs = highMatches(matches);
  if (highs.length === 1) {
    return {
      action: "merge",
      reason: mergeReason(highs[0]),
      personId: highs[0].personId,
      policyVersion: PEOPLE_IMPORT_AUTO_POLICY_VERSION,
    };
  }
  if (highs.length > 1) {
    return leave("auto:leave:ambiguous");
  }

  // Skip path (same evaluator as add/merge) — runs before moderate-match leave.
  if (isSelfCandidate(candidate, principalEmails, principalPhones)) {
    return {
      action: "skip",
      reason: "auto:skip:self",
      policyVersion: PEOPLE_IMPORT_AUTO_POLICY_VERSION,
    };
  }

  if (isSyntheticContactEmail(candidate.email) && !hasRealContactMethod(candidate)) {
    // Synthetic local keys without real contact methods — do not auto-add.
    return leave("auto:leave:incomplete_identity");
  }

  if (hasOptOutEvidence(candidate)) {
    return {
      action: "skip",
      reason: "auto:skip:opt_out",
      policyVersion: PEOPLE_IMPORT_AUTO_POLICY_VERSION,
    };
  }

  if (isJunkPattern(candidate)) {
    return {
      action: "skip",
      reason: "auto:skip:junk_pattern",
      policyVersion: PEOPLE_IMPORT_AUTO_POLICY_VERSION,
    };
  }

  if (!hasRealContactMethod(candidate) && !nameIsUsable(candidate)) {
    return {
      action: "skip",
      reason: "auto:skip:empty_identity",
      policyVersion: PEOPLE_IMPORT_AUTO_POLICY_VERSION,
    };
  }

  // Any non-high match means ambiguous identity for auto-add (no name-only path).
  if (matches.length > 0) {
    return leave("auto:leave:ambiguous");
  }

  // Add path — clear new identity, zero matches.
  if (!hasRealContactMethod(candidate) || !nameIsUsable(candidate)) {
    return leave("auto:leave:incomplete_identity");
  }

  if (!hasInteractionSignal(candidate)) {
    return leave("auto:leave:no_interaction");
  }

  return {
    action: "add",
    reason: "auto:add:clear_identity",
    policyVersion: PEOPLE_IMPORT_AUTO_POLICY_VERSION,
  };
}

export function isAutoImportSourceEnabled(source: string | undefined): boolean {
  return isDayOneAutoSource(source);
}
