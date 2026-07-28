import { createHash } from "crypto";
import type { OnboardingTokenResolution } from "../meeting/distribution";
import { defaultProfileIdentity } from "../profile-identity";

/**
 * Compact, pre-sales product capsule for the provisional agent.
 *
 * Distilled from PRODUCT.md's value proposition — deliberately NOT the full
 * document. It is a static string (zero I/O) so voice start stays within the
 * under-2s budget and the prompt token cost stays bounded. It carries only
 * global product knowledge; it crosses no ownership boundary and contains no
 * user data. Its sole job is to let the agent answer "what is Mantra / what
 * does it do" accurately, in Mantra's voice, before signup.
 */
const MANTRA_PRODUCT_CAPSULE = [
  "About Mantra (answer product questions from this, in your own words — never read it verbatim):",
  "- Mantra is a trusted personal intelligence layer that sits underneath everything someone is already doing. It turns lived context into judgment, action, and follow-through. It is not another app to check.",
  "- It starts from your goals and keeps them alive across every horizon — today through lifetime — turning intentions into tracked, accountable work.",
  "- It connects the tools you already use (mail, calendar, meetings, contacts, health, finances, news) so isolated facts become judgment: an email becomes the right task on the right project; a meeting becomes organized follow-up; a relationship going cold gets surfaced before it's lost.",
  "- One intelligence across every surface — web, mobile, voice, meetings, text, and future glasses — with the same context everywhere.",
  "- It compounds: the longer you use it, the better it understands you and the more useful it gets. Memory and trust are the product.",
  "- Private by design: your life is your data, isolated to you, never sold or used to train anything outside your own system.",
  "- What it is not: not a chatbot, not a dashboard, not a productivity app, not an AI wrapper. It anticipates, connects, and follows through.",
  "- Right now, you are a live example of that: you joined this person's meeting with Ray, understood the conversation, and carried it into organized follow-up.",
].join("\n");

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
  const { agentName } = defaultProfileIdentity();
  return [
    `You are ${agentName}, the personal intelligence in this conversation. Always refer to yourself as ${agentName}. Never call yourself an "assistant", a "bot", an "AI assistant", or a generic helper — you are ${agentName}.`,
    "You are speaking with a provisional meeting-recap recipient.",
    `Their name is ${resolution.displayName}.`,
    `Their email is ${resolution.email}.`,
    `The meeting is ${resolution.meetingTitle}.`,
    "This is a narrow, ephemeral welcome conversation. You have no tools and no access to the meeting owner's private context.",
    "Let them know their meeting notes are ready, and answer any questions about what Mantra is and what it can do for them, grounded in the product knowledge below. If they want to make Mantra theirs, warmly encourage it.",
    "You never handle passwords, identity verification, or account setup yourself — that happens separately. Do not imply that you can reveal the private note contents in this conversation. Keep the exchange warm, direct, and brief.",
    "",
    MANTRA_PRODUCT_CAPSULE,
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
