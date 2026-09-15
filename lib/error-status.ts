const REASON_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/exceeds\s+(?:this|the)\s+model'?s?\s+context\s+length/i, "context_length_exceeded"],
  [/context[\s_-]*length[\s_-]*exceeded/i, "context_length_exceeded"],
];

export function parseReasonFromErrorMessage(message: string): string | undefined {
  // Quoted machine-readable codes relayed by routers, for example
  // "code":"context_length_exceeded" or "provider_error_code":"context_length_exceeded".
  // Numeric "code":400 values are ignored; parseStatusFromErrorMessage handles the status.
  const quoted = message.match(/"(?:[a-z0-9_]+_)?code"\s*:\s*"([a-z0-9_.:-]+)"/i);
  if (quoted) return quoted[1];
  for (const [pattern, reason] of REASON_TEXT_PATTERNS) {
    if (pattern.test(message)) return reason;
  }
  return undefined;
}

export function parseStatusFromErrorMessage(message: string): number | undefined {
  const patterns: RegExp[] = [
    // Leading bare status code, optionally prefixed with "Error:", e.g. "401: {\"type\":\"CreditsError\"...}"
    // or "Error: 401: {\"type\":\"CreditsError\"...}" (OpenCode Go, OpenRouter relays)
    /^\s*(?:error\s*:?\s*)?([1-5][0-9]{2})\s*:/i,
    /\b(?:status|code|http)\s*[:\s]?\s*([1-5][0-9]{2})\b/i,
    /\bHTTP\/\d(?:\.\d)?\s+([1-5][0-9]{2})\b/,
    /\b(?:rate[\s-]?limit(?:ed)?|too many requests)[^0-9]{0,40}([45][0-9]{2})\b/i,
    /\b([45][0-9]{2})\s+(?:error|too many requests|service unavailable|bad gateway|gateway timeout|internal server error)\b/i,
    /\berror\s+([45][0-9]{2})\b/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) continue;
    const status = Number(match[1]);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }

  return undefined;
}
