import { createHash } from "crypto";
import type { OnboardingTokenResolution } from "../meeting/distribution";

export type ProvisionalVoiceResolution = Extract<
  OnboardingTokenResolution,
  { status: "resolved" }
>;

export interface ProvisionalVoiceIdentity {
  resolution: ProvisionalVoiceResolution;
  capabilityKey: string;
  tokenHash: string;
}

export function provisionalVoiceIdentity(
  rawToken: string,
  resolution: ProvisionalVoiceResolution,
): ProvisionalVoiceIdentity {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return {
    resolution,
    capabilityKey: `recap-ftue:${tokenHash}`,
    tokenHash,
  };
}

export function provisionalVoicePrompt(
  resolution: ProvisionalVoiceResolution,
): string {
  return [
    "You are Mantra, speaking with a provisional meeting-recap recipient.",
    `Their name is ${resolution.displayName}.`,
    `Their email is ${resolution.email}.`,
    `The meeting is ${resolution.meetingTitle}.`,
    "This is a narrow, ephemeral welcome conversation. You have no tools and no access to the meeting owner's private context.",
    "Help them understand that their meeting notes are ready. Never ask for a password, signup, account claim, or identity verification.",
    "Do not imply that you can reveal note contents in this conversation. Keep the exchange warm, direct, and brief.",
  ].join("\n");
}

export function provisionalFirstMessage(
  resolution: ProvisionalVoiceResolution,
): string {
  const preferred = resolution.displayName.trim().split(/\s+/)[0];
  const name = preferred && !preferred.includes("@") ? preferred : "there";
  const meeting = /\b(?:call|meeting)$/i.test(resolution.meetingTitle)
    ? resolution.meetingTitle
    : `${resolution.meetingTitle} call`;
  return `Hey ${name} — I've got your notes from the ${meeting}.`;
}
