import * as WebStreams from 'web-streams-polyfill/dist/polyfill';
import { markStartupPhase } from '../lib/startup-telemetry';

try {
  markStartupPhase('register_globals_start');
} catch {}

const WEB_STREAM_GLOBALS = [
  'ReadableStream',
  'ReadableStreamBYOBReader',
  'ReadableStreamBYOBRequest',
  'ReadableStreamDefaultController',
  'ReadableStreamDefaultReader',
  'WritableStream',
  'WritableStreamDefaultController',
  'WritableStreamDefaultWriter',
  'TransformStream',
  'TransformStreamDefaultController',
  'ByteLengthQueuingStrategy',
  'CountQueuingStrategy',
];

for (const globalName of WEB_STREAM_GLOBALS) {
  if (typeof globalThis[globalName] === 'undefined' && WebStreams[globalName]) {
    Object.defineProperty(globalThis, globalName, {
      configurable: true,
      value: WebStreams[globalName],
      writable: true,
    });
  }
}

try {
  markStartupPhase('register_globals_done');
} catch {}
