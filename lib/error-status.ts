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

// Failure modes where the transport reports HTTP success but the provider
// yields nothing usable — no numeric status is present in any of them, so the
// status parser must synthesize one for the fallback rules to fire:
// - "Provider returned an empty response" (OpenRouter stealth/pool models)
// - "Stream ended without finish_reason" (chunk stream truncated mid-flight)
// - "<provider> response has no body" (Anthropic/Mistral/generic, 200 empty body)
// - "<provider> stream ended without a terminal event" (SSE stream dies silently)
const EMPTY_PROVIDER_RESPONSE_PATTERNS: RegExp[] = [
  /provider returned an empty response/i,
  /response (has|with) no body/i,
  /stream ended without a terminal event/i,
  /stream ended without finish_reason/i,
];

export function parseStatusFromErrorMessage(message: string): number | undefined {
  for (const pattern of EMPTY_PROVIDER_RESPONSE_PATTERNS) {
    if (pattern.test(message)) {
      // Synthesize 502 so status-based fallback rules fire instead of the
      // agent silently retrying the same model. 502 is deliberately chosen
      // over a novel code: it lands in the 5xx status lists users already
      // configure and inherits the standard 10-minute cooldown.
      return 502;
    }
  }
  const patterns: RegExp[] = [
    // Leading bare status code, optionally prefixed with "Error:", e.g. "401: {\"type\":\"CreditsError\"...}"
    // or "Error: 401: {\"type\":\"CreditsError\"...}" (OpenCode Go, OpenRouter relays)
    /^\s*(?:error\s*:?\s*)?([1-5][0-9]{2})\s*:/i,
    // Anchored "Error: <status> <prose>", e.g. "Error: 429 quota exceeded"
    // (GitHub Copilot). The pattern above needs a colon AFTER the status and the
    // "error <status>" pattern below needs whitespace directly after "error", so
    // a message carrying both the prefix and a colon fell between them. The
    // "error" prefix is required: without it this would also match prose such as
    // "429 tokens remaining in context window", which must stay unmatched.
    /^\s*error\s*:?\s*([1-5][0-9]{2})\b/i,
    /\b(?:status|code|http)\s*[:\s]?\s*([1-5][0-9]{2})\b/i,
    // Parenthesized status inside a provider error wrapper, e.g.
    // "omni API error (503): overloaded" or "chat_completion_error (429): ...".
    // Without this the wrapper text sits between "error" and the number, so the
    // anchored "error <status>" pattern cannot see it and the rule set never
    // sees a status at all. The wrapper keyword and the parentheses are both
    // required so prose such as "(503) items processed" stays unmatched.
    /\b\w*(?:error|failure|failed)\s*\(\s*([1-5][0-9]{2})\s*\)/i,
    /\bHTTP\/\d(?:\.\d)?\s+([1-5][0-9]{2})\b/,
    /\b(?:rate[\s-]?limit(?:ed)?|too many requests)[^0-9]{0,40}([45][0-9]{2})\b/i,
    /\b([45][0-9]{2})\s+(?:error|quota|too many requests|service unavailable|bad gateway|gateway timeout|internal server error)\b/i,
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
