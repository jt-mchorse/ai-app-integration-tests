import { createHash } from "node:crypto";

/**
 * Cassette schema (v1).
 *
 * One file per recorded request/response pair, named `<requestHash>.json`.
 * The file is the source of truth for replay; nothing else is consulted.
 */
export interface CassetteV1 {
  schema_version: "1";
  /** Hash that names the file. Recomputed on read to guard against rename drift. */
  request_hash: string;
  request: NormalizedRequest;
  response: RecordedResponse;
  /** ISO-8601 wall clock when the recording was made. Informational only. */
  recorded_at: string;
}

export interface NormalizedRequest {
  method: string;
  /** URL with query parameters sorted (so `?a=1&b=2` and `?b=2&a=1` hash equal). */
  url: string;
  /** Headers AFTER redaction (D-004). Sorted by name. */
  headers: Record<string, string>;
  /** Body AFTER normalization (sorted keys recursively). null for GET/HEAD. */
  body: unknown;
}

export type RecordedResponse =
  | {
      kind: "non_streaming";
      status: number;
      headers: Record<string, string>;
      body: string;
    }
  | {
      kind: "sse";
      status: number;
      headers: Record<string, string>;
      /**
       * The raw event sequence as it left the wire. Each element is the text
       * of one SSE frame including its terminating `\n\n`.
       */
      frames: string[];
    };

/* ------------------------------------------------------------------ */
/* Normalization + hashing                                            */
/* ------------------------------------------------------------------ */

/**
 * Recursively sort object keys so two semantically-equivalent JSON bodies
 * produce identical bytes. Arrays preserve order (sequence matters in
 * `messages: [...]`); only object keys are sorted.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function normalizeUrl(url: string): string {
  const u = new URL(url);
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);
  return u.toString();
}

export function hashRequest(req: NormalizedRequest): string {
  const payload = JSON.stringify({
    method: req.method,
    url: req.url,
    body: req.body,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* Redaction (D-004)                                                  */
/* ------------------------------------------------------------------ */

/**
 * Strip credentials from headers before write. The recorder runs this and
 * also asserts the result against API-key shapes (sk-…, anything matching
 * `[A-Za-z0-9_-]{32,}` in a sensitive header).
 */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "anthropic-api-key",
  "openai-api-key",
  "x-amz-security-token",
  "cookie",
  "set-cookie",
]);

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = v;
    }
  }
  // Sort headers by name for stable output.
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return sorted;
}

/**
 * Belt-and-suspenders check (D-004): scan the entire serialized cassette for
 * anything that *looks* like an API key. Throws if any candidate is found so
 * a leaking cassette never gets committed.
 *
 * Heuristic: 32+ chars of `[A-Za-z0-9_-]` immediately preceded by `sk-`, `key=`,
 * `Bearer `, etc., in a header VALUE. The `[REDACTED]` placeholder is
 * exempted because it's the redaction marker, not a leaked key.
 */
const API_KEY_PATTERNS: Array<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{32,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
  /\bBearer\s+[A-Za-z0-9_.\-/+=]{20,}\b/,
];

export function assertNoLeakedSecrets(cassette: CassetteV1): void {
  const serialized = JSON.stringify(cassette);
  for (const pattern of API_KEY_PATTERNS) {
    const m = serialized.match(pattern);
    if (m) {
      throw new Error(
        `cassette appears to contain an unredacted secret matching ${pattern.source}; ` +
          `refusing to write. Update redactHeaders() and re-record.`,
      );
    }
  }
}
