export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
export const DEFAULT_PROVIDER_ERROR_BODY_BYTES = 4_096;

export interface ProviderFetchOptions extends RequestInit {
  timeoutMs?: number;
}

function composeProviderSignal(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/**
 * Fixed-origin provider adapters use this boundary so every request owns a real
 * cancellation deadline. Business semantics, credentials, retries, and status
 * interpretation remain in the adapter that called it.
 */
export async function providerFetch(
  url: string | URL,
  options: ProviderFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS, signal, ...init } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Provider request timeout must be a positive finite number");
  }
  return fetch(url, {
    ...init,
    signal: composeProviderSignal(signal, timeoutMs),
  });
}

/** Read at most maxBytes from an untrusted provider response body. */
export async function readBoundedProviderBody(
  response: Response,
  maxBytes = DEFAULT_PROVIDER_ERROR_BODY_BYTES,
): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Provider response body limit must be a positive integer");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = maxBytes;
  let body = "";

  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      body += decoder.decode(slice, { stream: true });
      remaining -= slice.byteLength;
      if (slice.byteLength < value.byteLength) break;
    }
    body += decoder.decode();
    return body;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
