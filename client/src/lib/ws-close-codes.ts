const WS_CLOSE_CODE_DESCRIPTIONS: Record<number, string> = {
  1000: "normal closure",
  1001: "server going away",
  1002: "protocol error",
  1003: "unsupported data",
  1005: "no status received",
  1006: "network interruption",
  1007: "invalid frame payload",
  1008: "policy violation",
  1009: "message too big",
  1010: "missing extension",
  1011: "internal server error",
  1012: "service restart",
  1013: "try again later",
  1014: "bad gateway",
  1015: "TLS handshake failure",
};

export function describeCloseCode(code: string | number | undefined): string {
  if (code === undefined || code === "" || code === null) return "unknown reason";
  const numeric = typeof code === "string" ? parseInt(code, 10) : code;
  if (isNaN(numeric)) return String(code);
  return WS_CLOSE_CODE_DESCRIPTIONS[numeric] || `code ${numeric}`;
}

export function buildDisconnectReason(closeCode: string, closeReason: string, reason: string): string {
  const codeDesc = describeCloseCode(closeCode);
  if (closeReason && closeReason !== "(unknown)") {
    return `${codeDesc} — ${closeReason}`;
  }
  if (reason && reason !== "(unknown)") {
    return `${codeDesc} — ${reason}`;
  }
  return codeDesc;
}
