const PATTERNS: [RegExp, string][] = [
  // eslint-disable-next-line no-control-regex
  [/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""], // ANSI escapes
  // eslint-disable-next-line no-control-regex
  [/[\x00-\x08\x0b-\x1f\x7f]/g, ""], // other control chars
  [/\b(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g, "[REDACTED]"],
  [/\b(glpat-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@"], // user:pass@ in URLs
  [/\b(authorization|proxy-authorization)\s*:\s*\S+(\s+\S+)?/gi, "$1: [REDACTED]"],
  [/\b(base64:)[A-Za-z0-9+/=]{20,}/g, "$1[REDACTED]"], // Laravel APP_KEY
  [
    /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    "$1$2[REDACTED]",
  ],
];

/**
 * Builds a sanitizer for deployment logs: strips terminal escapes, removes the
 * app's known secret values verbatim, and masks common credential formats.
 */
export function createRedactor(secrets: Iterable<string>) {
  const known = [...new Set([...secrets].filter((s) => s && s.length >= 4))].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const s of known) out = out.split(s).join("[REDACTED]");
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
  };
}

/** Keeps the head and tail of an oversized log. */
export function clampLog(text: string, max = 256 * 1024) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - max} karakter dipotong] …\n${text.slice(-half)}`;
}
