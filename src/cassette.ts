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
  /**
   * How `body` was derived from the wire bytes (#57). A JSON body is stored as
   * its parsed+canonicalized value; a non-JSON body is stored as its plain
   * text. Those two value spaces overlap — a raw body `foo` and a JSON string
   * `"foo"`, or (under the old `{__raw_body__: text}` wrapper) a raw `foo` and a
   * literal JSON `{"__raw_body__":"foo"}`, canonicalize to identical `body` and
   * so hash-collide. This sibling discriminator lives OUTSIDE `body`, so no
   * caller-supplied JSON can forge it. Omitted when there is no body. "json" is
   * informational; only "raw" is folded into the request hash (see
   * `hashRequest`) so existing JSON-body and no-body cassette hashes are
   * unchanged.
   */
  bodyEncoding?: "json" | "raw";
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
 * Locale-independent, code-unit string comparison. Mirrors the ordering of
 * the default `Array.prototype.sort()` (used by `canonicalize` on body keys),
 * so URL params and body keys canonicalize identically. Must NOT use
 * `localeCompare` — its result depends on the runtime's default ICU locale,
 * which differs across dev machines and CI runners and would make the request
 * hash non-reproducible across environments (silent replay miss). See #50.
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
  // Sort by key, then break ties by value. Comparing keys only left repeated
  // same-key params (`?tag=a&tag=b`) in input order — JS sort is stable — so
  // `?tag=a&tag=b` and `?tag=b&tag=a` produced different hashes and a replay
  // miss (D-005 throws, no silent fallback). Tie-breaking by value canonicalizes
  // them, consistent with the by-key sort and `canonicalize`'s body-key sort.
  //
  // Code-unit comparison, NOT localeCompare (#50): localeCompare's ordering is
  // locale-dependent, so a cassette recorded under one ICU locale would hash a
  // different param order than the same request normalized under another —
  // breaking cross-environment replay and diverging from `canonicalize`'s
  // default `.sort()` on body keys. `compareCodeUnits` is locale-independent
  // and matches that body-key ordering exactly.
  const params = [...u.searchParams.entries()].sort(
    ([ka, va], [kb, vb]) => compareCodeUnits(ka, kb) || compareCodeUnits(va, vb),
  );
  u.search = "";
  // Drop the fragment: per RFC 3986 §3.5 / the WHATWG fetch spec it is a
  // client-side-only construct never sent to the server, so two requests that
  // differ only by `#...` are wire-identical and must hash the same. Leaving it
  // in produced a replay miss (MissingCassetteError) for a request recorded
  // with a fragment and replayed without one — the same canonicalization class
  // as the query-param ordering fix (#42/#51), one field over. See #56.
  u.hash = "";
  // Drop userinfo (RFC 3986 §3.2.1): a `user:pass@host` credential must never be
  // committed in cleartext. fetch turns `user:pass@` into an `Authorization:
  // Basic …` header, which `redactHeaders` already redacts — but as URL userinfo
  // the same credential slips both layers (no API_KEY_PATTERN matched it). It is
  // also non-wire-distinguishing for hashing (the server sees the header, not the
  // URL userinfo), so two requests differing only by credentials hash the same —
  // the same canonicalization class as the fragment strip above (#56). See #64.
  u.username = "";
  u.password = "";
  for (const [k, v] of params) u.searchParams.append(k, v);
  return u.toString();
}

export function hashRequest(req: NormalizedRequest): string {
  // Fold `bodyEncoding` into the hash ONLY for raw bodies (#57). A raw body is
  // stored as its plain text, which is indistinguishable from a JSON value of
  // the same canonical shape once normalized — the collision between raw `foo`
  // and JSON `{"__raw_body__":"foo"}` (old wrapper), or raw `foo` and JSON
  // `"foo"`. Tagging only the raw case keeps every existing JSON-body and
  // no-body hash byte-identical, so already-recorded cassettes still replay.
  const payload = JSON.stringify({
    method: req.method,
    url: req.url,
    body: req.body,
    ...(req.bodyEncoding === "raw" ? { bodyEncoding: "raw" } : {}),
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
  // `proxy-authorization` (RFC 7235) carries proxy credentials — typically a
  // `Basic …` value the prefix-based scanner below does not catch. Without this
  // entry a cassette recorded through an authenticating proxy committed the
  // credential verbatim (#54).
  "proxy-authorization",
  "x-api-key",
  // Azure OpenAI authenticates with a bare `api-key` header whose value is a
  // prefix-less 32-hex string — invisible to the `sk-`/`Bearer`/`AIza`
  // patterns below, so redaction-by-name is the only thing that catches it (#54).
  "api-key",
  "anthropic-api-key",
  "openai-api-key",
  // `x-goog-api-key` is the canonical header for Google Gemini / Vertex AI
  // and the official Anthropic-via-Vertex SDK paths. Without this entry a
  // cassette recorded against a Google API committed the key value.
  "x-goog-api-key",
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
 *
 * NOTE (#60): none of these patterns ends in a trailing `\b`. Each charclass can
 * end in a NON-word char (`=` base64 padding, `+` `/` `-` `.`), and a `\b` only
 * anchors at a word↔non-word transition — so a credential ending in such a char
 * (when it's short enough that the trailing char is needed to satisfy `{N,}`)
 * would slip the scanner and leak into a committed cassette. The leading
 * `\b<prefix>` already anchors the start; dropping the trailing anchor only ever
 * widens what we catch, which is the safe direction for a leak guard (D-004).
 */
const API_KEY_PATTERNS: Array<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{32,}/,
  /\bsk-ant-[A-Za-z0-9_-]{32,}/,
  /\bBearer\s+[A-Za-z0-9_.\-/+=]{20,}/,
  // Google / Gemini / Vertex AI keys (`AIza` + 35+ url-safe chars; real keys
  // are 39 chars total). The `x-goog-api-key` header is already redacted (#22);
  // this catches the same key class leaking through an un-redacted channel —
  // e.g. an upstream 400 error body that echoes the submitted key. Open-ended
  // length matches the `sk-…{32,}` style above and avoids brittleness.
  /\bAIza[A-Za-z0-9_-]{35,}/,
  // HTTP Basic credentials (`Basic ` + base64). `proxy-authorization` is now
  // redacted by name (#54), but a Basic value can still surface through an
  // un-redacted channel (an echoed error body, a custom auth header), and the
  // prefix-based patterns above would miss it. 16+ base64 chars ≈ an 8+ byte
  // `user:pass`, well clear of incidental short tokens.
  /\bBasic\s+[A-Za-z0-9+/=]{16,}/,
  // URL userinfo credentials (`scheme://user:pass@host`, RFC 3986 §3.2.1).
  // `normalizeUrl` now strips userinfo before write (#64), but a userinfo URL
  // can still surface through an un-redacted channel — an echoed error body, a
  // request body carrying a connection string. Anchored on `//` + a non-empty
  // userinfo + `:` + non-empty password + `@` so it matches the `scheme://u:p@`
  // shape specifically; the `//` and the no-`@`/no-space charclasses keep it off
  // incidental JSON `:`/`@` (timestamps like `12:30`, emails like `a@b.com`,
  // which have no preceding `//`). Catches the credential leaking either way (D-004).
  /\/\/[^/@\s:]+:[^/@\s]+@/,
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
