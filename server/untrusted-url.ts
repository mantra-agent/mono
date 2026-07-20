import { isIP } from "node:net";
import { promises as dns } from "node:dns";

const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^224\./,
  /^255\./,
];

function isPrivateAddress(address: string): boolean {
  if (address === "::" || address === "::1" || address.toLowerCase().startsWith("fe80:") || address.toLowerCase().startsWith("fc") || address.toLowerCase().startsWith("fd")) return true;
  if (address.startsWith("::ffff:")) return isPrivateAddress(address.slice(7));
  return PRIVATE_IPV4.some((pattern) => pattern.test(address));
}

export async function assertSafeUntrustedHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) URLs are allowed");
  if (url.username || url.password) throw new Error("Credential-bearing URLs are not allowed");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Local or internal hosts are not allowed");
  }
  const addresses = isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("URL resolves to a private or reserved network address");
  }
  return url;
}

export async function fetchUntrustedUrl(rawUrl: string, init: RequestInit = {}, maxRedirects = 3): Promise<Response> {
  let current = await assertSafeUntrustedHttpUrl(rawUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirect === maxRedirects) throw new Error("Too many redirects");
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirect missing location");
    current = await assertSafeUntrustedHttpUrl(new URL(location, current).toString());
  }
  throw new Error("Unreachable redirect state");
}
