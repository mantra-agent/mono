import { createLogger } from "../log";
import { purgeExpiredMeetingAudio } from "./audio-retention";

const log = createLogger("MeetingAudioExpiry");
const EXPIRY_INTERVAL_MS = 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const purged = await purgeExpiredMeetingAudio();
    if (purged > 0) log.info("Expired meeting audio purged", { purged });
  } catch (error) {
    log.error("Meeting audio expiry pass failed", { errorType: error instanceof Error ? error.name : typeof error });
  } finally {
    running = false;
  }
}

export function startMeetingAudioExpiry(): void {
  if (timer) return;
  void runOnce();
  timer = setInterval(() => void runOnce(), EXPIRY_INTERVAL_MS);
  timer.unref?.();
}

export function stopMeetingAudioExpiry(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
