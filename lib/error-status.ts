export function parseStatusFromErrorMessage(message: string): number | undefined {
  const patterns: RegExp[] = [
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
