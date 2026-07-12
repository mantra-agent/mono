import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { PassThrough } from "stream";
import type WebSocket from "ws";
import { meetingTTSProvider } from "../meeting/tts/provider";
import { createLogger } from "../log";

const log = createLogger("PhoneAudio");
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

async function toMulaw8k(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const source = new PassThrough();
    const chunks: Buffer[] = [];
    const output = new PassThrough();
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    output.on("end", () => resolve(Buffer.concat(chunks)));
    ffmpeg(source).noVideo().audioChannels(1).audioFrequency(8000).format("mulaw")
      .on("error", reject).pipe(output);
    source.end(input);
  });
}

export async function sendPhoneSpeech(socket: WebSocket, streamSid: string, text: string, markName: string): Promise<void> {
  const audio = await meetingTTSProvider.synthesize({ text });
  const mulaw = await toMulaw8k(audio.bytes);
  socket.send(JSON.stringify({ event: "media", streamSid, media: { payload: mulaw.toString("base64") } }));
  socket.send(JSON.stringify({ event: "mark", streamSid, mark: { name: markName } }));
  log.info(`phone speech queued streamSid=${streamSid} provider=${audio.provider} bytes=${mulaw.length} mark=${markName}`);
}

export function clearPhoneSpeech(socket: WebSocket, streamSid: string): void {
  socket.send(JSON.stringify({ event: "clear", streamSid }));
}
