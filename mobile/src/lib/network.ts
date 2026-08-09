import Config from '../config';

export const MOBILE_REQUEST_TIMEOUT_MS = 15_000;

interface ServerRequestInit extends RequestInit {
  timeoutMs?: number;
}

/**
 * Canonical authenticated mobile transport. Resolves the selected backend at
 * request time, composes caller cancellation with a real deadline, and never
 * retries mutations whose provider outcome may be ambiguous.
 */
export async function requestServer(
  path: string,
  init: ServerRequestInit = {},
): Promise<Response> {
  await Config.load();
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? MOBILE_REQUEST_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort();

  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const { timeoutMs: _timeoutMs, signal: _signal, ...requestInit } = init;
    return await fetch(`${Config.SERVER_URL}${path}`, {
      ...requestInit,
      credentials: 'include',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}
