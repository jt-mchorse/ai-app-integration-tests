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
   * unchanged. "base64" marks a body whose bytes are not valid UTF-8, stored
   * as their base64 and folded into the hash like "raw" (#147, D-015).
   */
  bodyEncoding?: "json" | "raw" | "base64";
}

export type RecordedResponse =
  | {
      kind: "non_streaming";
      status: number;
      headers: Record<string, string>;
      body: string;
      /**
       * Present only when the response bytes are not valid UTF-8: `body` is
       * then their base64, and the replayer decodes it back to bytes (#173).
       * Omitted for every UTF-8 body, which is stored as its text exactly as
       * before -- the response-side twin of the request's D-015 rule.
       */
      bodyEncoding?: "base64";
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
    // Null-prototype accumulator: a body key literally named `__proto__` is a
    // real own-enumerable key after `JSON.parse`, but assigning `out["__proto__"]`
    // on a plain `{}` hits the prototype *setter* — it mutates `out`'s prototype
    // instead of creating an own property, and `JSON.stringify` then omits it. The
    // field would vanish, so a body with `__proto__` canonicalizes identically to
    // the same body without it: two different requests hash-collide and replay
    // serves the wrong cassette (#75; same invariant as #57/#70). `Object.create(null)`
    // has no `__proto__` accessor, so the assignment creates an own property and
    // the field is hashed. `Object.keys`/`.sort()`/`JSON.stringify` are unchanged
    // on null-prototype objects, so every other body is byte-identical.
    const out: Record<string, unknown> = Object.create(null);
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
  // Fold `bodyEncoding` into the hash for raw bodies (#57) AND for a present
  // body that canonicalizes to `null` (#70). A raw body is stored as its plain
  // text, indistinguishable from a JSON value of the same canonical shape once
  // normalized — the collision between raw `foo` and JSON `{"__raw_body__":
  // "foo"}` (old wrapper), or raw `foo` and JSON `"foo"`. Separately, a JSON
  // literal `null` body canonicalizes to `body:null`, byte-identical to a
  // *no-body* request (`body:null`, no encoding tag): without the tag the two
  // hash the same, the recorder overwrites one cassette with the other, and
  // replay serves the wrong response. Folding the tag only in these two cases
  // (raw, or present-but-null) keeps every non-null JSON-body and no-body hash
  // byte-identical, so already-recorded cassettes still replay.
  // "base64" (#147) is folded for the same reason as "raw": the base64 string
  // is otherwise indistinguishable from a text body spelling it.
  const foldEncoding =
    req.bodyEncoding === "raw" ||
    req.bodyEncoding === "base64" ||
    (req.bodyEncoding !== undefined && req.body === null);
  const payload = JSON.stringify({
    method: req.method,
    url: req.url,
    body: req.body,
    ...(foldEncoding ? { bodyEncoding: req.bodyEncoding } : {}),
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
  // Both accumulators below are `Object.create(null)` for the reason
  // `canonicalize` states one screen up (#75), applied to the population that
  // reasoning actually describes (#115): every `out[k] = v` on an object
  // literal, not only the body one. A `__proto__` header assigned on a plain
  // `{}` hits the prototype setter and vanishes — and it reaches here as a real
  // own-enumerable key, both from `collectHeaders` and from `JSON.parse` of a
  // committed cassette, so a re-record drops a header the previous recording
  // had and the file changes without the request changing.
  //
  // `Object.keys`/`.sort()`/`JSON.stringify` are unchanged on null-prototype
  // objects, so every other cassette stays byte-identical — the same argument
  // #75's comment makes, and `test/cassette-proto-header.test.ts` runs it
  // against the committed fixtures rather than restating it.
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = v;
    }
  }
  // Sort headers by name for stable output.
  const sorted: Record<string, string> = Object.create(null);
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return sorted;
}

/**
 * The compound credential names of the `key=`-family pattern below (#113,
 * #246, #250), in one place so its `/i` form and its case-sensitive camelCase
 * form (#251) cannot drift apart. Letters, `[-_]?` and groups only: `anyCase`
 * relies on that.
 */
const CREDENTIAL_NAMES =
  "api[-_]?(?:key|token|secret)|access[-_]?(?:token|key)|auth[-_]?token|subscription[-_]?key|" +
  "client[-_]?secret|refresh[-_]?token|id[-_]?token|subject[-_]?token|actor[-_]?token|" +
  "private[-_]?token|session[-_]?token|security[-_]?token|secret[-_]?key|password|client[-_]?assertion";

/**
 * What follows a credential name: `=` or `:`, optional quotes, a 24+ char value.
 *
 * `~` is in the class (#261): it is in RFC 6750's `b64token` and RFC 3986's
 * unreserved set, and every Microsoft Entra ID client secret has one at
 * position 5 (`xxxNQ~…`). Without it a `~` in the first 24 characters ended the
 * match, so the request went out live, the secret was written to the cassette,
 * and the committed-cassette rescan passed it.
 */
const CREDENTIAL_VALUE = String.raw`["']?\s*[=:]\s*["']?([A-Za-z0-9_\-.+/=~]{24,})`;

/** Each letter `x` as `[xX]`: a case-insensitive name in a case-sensitive pattern (#251). */
function anyCase(source: string): string {
  return source.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
}

/**
 * Belt-and-suspenders check (D-004): scan the entire serialized cassette for
 * anything that *looks* like an API key. Throws if any candidate is found so
 * a leaking cassette never gets committed.
 *
 * Heuristic: a credential-shaped value behind a recognised prefix — `sk-`,
 * `Bearer `, `AIza`, `Basic `, URL userinfo, or a `key=`-family name. The
 * `[REDACTED]` placeholder is exempted because it's the redaction marker, not
 * a leaked key.
 *
 * This used to say "in a header VALUE", and to list `key=` among the prefixes
 * when no such pattern existed (#113). Both were wrong in the same direction:
 * the scan runs over the WHOLE serialized cassette precisely because the URL
 * and the body are where a credential escapes header redaction, and `key=` is
 * the shape those two carry.
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
  // `i` on both auth-scheme patterns (#201): a scheme name is case-insensitive
  // (RFC 9110 §11.1), and these two exist for the un-redacted channels -- a
  // custom header, a body, an echoed error -- where the spelling is whatever the
  // sender chose. Without it `bearer <token>` and `BASIC <base64>` were written
  // to the cassette. The credential classes already hold both cases, so the
  // flag changes only how the scheme word matches.
  // `~` as for `CREDENTIAL_VALUE`: RFC 6750's `b64token` allows it (#261).
  /\bBearer\s+[A-Za-z0-9_.\-/+=~]{20,}/i,
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
  /\bBasic\s+[A-Za-z0-9+/=]{16,}/i,
  // URL userinfo credentials (`scheme://user:pass@host`, RFC 3986 §3.2.1).
  // `normalizeUrl` now strips userinfo before write (#64), but a userinfo URL
  // can still surface through an un-redacted channel — an echoed error body, a
  // request body carrying a connection string. Anchored on `//` + a username +
  // `:` + non-empty password + `@` so it matches the `scheme://u:p@` shape
  // specifically; the `//` and the no-`@`/no-space charclasses keep it off
  // incidental JSON `:`/`@` (timestamps like `12:30`, emails like `a@b.com`,
  // which have no preceding `//`). Catches the credential leaking either way (D-004).
  //
  // The username may be EMPTY (#263). RFC 3986 lets either side of the `:` be
  // empty, and `redis://:password@host` is the ordinary Redis/AMQP form for a
  // password with no user. Requiring a username passed it, and such passwords
  // are often under the 24 characters the `password` name rule needs, so it was
  // written. The password stays non-empty: `redis://user:@host` carries nothing.
  // A token as the username with no `:` (`https://<token>@github.com`) is not
  // matched, because `ssh://git@github.com` has the same shape and must record.
  /\/\/[^/@\s:]*:[^/@\s]+@/,
  // A `key=`-family name followed by a credential-shaped value. The docstring
  // above promised this prefix for a long time and no pattern implemented it
  // (#113); these are the shapes the other six structurally cannot see. Five of
  // them key off the credential's own PREFIX (`sk-`, `Bearer `, `AIza`,
  // `Basic `) and these credentials have none — Azure OpenAI's `api-key` is a
  // bare 32-hex string, an OAuth `access_token` is opaque. The sixth, userinfo,
  // keys off URL STRUCTURE rather than a prefix, and so misses them for the
  // different reason that they are not in a `//u:p@` position. The `api-key` header entry's own comment says
  // "redaction-by-name is the only thing that catches it", which is exactly why
  // the same value in any position that is not a header name was caught by
  // nothing.
  //
  // The URL case is not hypothetical the way the "echoed error body" rationale
  // above it is: `normalizeUrl` strips the fragment (#56) and userinfo (#64)
  // and PRESERVES the query string, so `?api-key=<key>` is written into the
  // committed cassette every time. Azure OpenAI, Google (`?key=`), OAuth
  // (`?access_token=`) and Azure SAS all put credentials there.
  //
  // Matches both `name=value` (query string) and `"name": "value"` (JSON body).
  // `\b` before the alternation is load-bearing: without it `monkey=...` matches
  // on its trailing "key". 24+ chars rather than 32+ because an opaque OAuth
  // token is routinely shorter than an API key, and this pattern is anchored on
  // a name that means "credential" — the anchor carries the specificity, so the
  // length bound does not have to. A leak guard that also refuses a `model=`
  // name or a base64 image chunk gets switched off, so the negative rows in
  // `test/cassette-leak-scanner.test.ts` are as load-bearing as the positive.
  //
  // The compound names take a `(?<![A-Za-z0-9])` rather than that `\b` (#246).
  // `_` is a word character, so `\b` refused `x-api-key` and passed `x_api_key`,
  // `openai_api_key` and `x_access_token` even though the name itself already
  // treats `-` and `_` alike (`[-_]?`). A compound name is a credential whatever
  // is joined in front of it, so only a letter or digit (`myapikey`) blocks it.
  // `subscription[-_]?key` is Azure API Management's name, and was refused
  // as `subscription-key` but passed as `subscription_key` for the same reason.
  // Bare `key` keeps the `\b`, because it is the part that stops `monkey=`:
  // `cache_key` / `idempotency_key` stay accepted and `cache-key` /
  // `idempotency-key` stay refused. `test/leak-scanner-snake-case-prefix.test.ts`
  // pins that table.
  //
  // The name list is enumerated from the specs and vendor docs, not from memory
  // (#250): it held four names, so an ordinary OAuth token request carrying
  // `client_secret`, `refresh_token` or `password` went live and was written.
  //   - RFC 6749: `client_secret` (§2.3.1), `password` (§4.3.2), `access_token`
  //     and `refresh_token` (§5.1, §6); OIDC Core adds `id_token`.
  //   - RFC 7521/7523: `assertion`, `client_assertion`.
  //   - RFC 8693: `subject_token`, `actor_token`. RFC 7009/7662: bare `token`.
  //   - Vendor names: `api_token` / `x-api-token`, `private-token` (GitLab),
  //     `session_token` / `security_token` (AWS STS, `X-Amz-Security-Token=`),
  //     `access_key` / `secret_key` / `aws_secret_access_key`, `api_secret`,
  //     `x-client-secret`, and `<vendor>-token` headers (`x-vault-token`).
  // `password` means a credential whatever is joined in front (`db_password`),
  // so it takes the lookbehind. `secret` is a generic noun like `key` and takes
  // its `\b`. RFC 6749's `code` is left out: it is the error-code field of
  // every JSON error body, single-use, and a name rule on it would refuse
  // ordinary responses. Bare `token` and `assertion` are left out of this
  // pattern for the same reason, and refused on the form surfaces only
  // (`FORM_SURFACE_PATTERNS`, #256).
  new RegExp(String.raw`(?:(?<![A-Za-z0-9])(?:${CREDENTIAL_NAMES})|\b(?:key|secret))${CREDENTIAL_VALUE}`, "i"),
  // The camelCase join (#251). #248's lookbehind blocks every letter in front
  // of a compound name, so `openaiApiKey`, `xApiKey` and `userAccessToken` (the
  // usual join in a JS/TS JSON body) went live and were written while `apiKey`
  // and `openai_api_key` were refused. A camelCase join is the name's first
  // letter in UPPERCASE after a letter or digit, which needs a case-sensitive
  // pattern: under `/i` the `[A-Z]` would match any letter and refuse the pinned
  // `myapikey`. The uppercase letter is the name's own, not the one before it,
  // so LangChain's `openAIApiKey` (`I` then `Api`) matches too. The rest of the
  // name is matched in any case (`APIKey`, `ApiKey`). `key`, `token` and
  // `secret` get no camelCase join, as they get no `_` join: `cacheKey` and
  // `nextPageToken` still record, like `cache_key`. A header name reaches the
  // scanner lower-cased, so this covers the URL, body and response only.
  // `test/leak-scanner-camel-case-prefix.test.ts` pins the table.
  new RegExp(String.raw`(?<=[A-Za-z0-9])(?=[A-Z])(?:${anyCase(CREDENTIAL_NAMES)})${CREDENTIAL_VALUE}`),
];

/**
 * Names that are a credential only where the specs put them (#256): the URL
 * query, a request header, and a form body (form-urlencoded, multipart, or a
 * FormData record). `assertNoLeakedSecrets` applies these to the texts
 * `scanTexts` collects from those surfaces, and to nothing else.
 *
 * #253 added bare `token` (RFC 7009/7662) and `assertion` (RFC 7521) to the
 * pattern above, which reads every text in the cassette. An OpenAI logprobs
 * response carries every output token as `{"token": "<text>", ...}`, in a
 * JSON body and in each SSE `data:` chunk, and tokenizers have single tokens
 * of 24+ value-class characters: cl100k_base has 71 (32 dashes, 32 `=`,
 * `.translatesAutoresizingMaskIntoConstraints`, ...), o200k_base 45. Such a
 * response was refused after the live call. `{"assertion": ...}` and
 * `{"lastAssertion": ...}` are eval-shaped JSON in the same way. RFC 7009 and
 * 7521 send both names form-urlencoded, and `x-vault-token`-style headers put
 * `token` in a header name, so those surfaces keep the rule. Compound names
 * (`access_token`, `refresh_token`, `client_assertion`, ...) are in the pattern
 * above and are refused everywhere. `test/leak-scanner-logprobs-token.test.ts`
 * pins the table.
 */
const FORM_SURFACE_PATTERNS: Array<RegExp> = [
  new RegExp(String.raw`(?:(?<![A-Za-z0-9])assertion|\btoken)${CREDENTIAL_VALUE}`, "i"),
  new RegExp(String.raw`(?<=[A-Za-z0-9])(?=[A-Z])${anyCase("assertion")}${CREDENTIAL_VALUE}`),
];

/**
 * A whole string in `application/x-www-form-urlencoded` shape (#256): one or
 * more `name=value` pairs joined by `&`, a name of URL-safe characters, and no
 * whitespace anywhere. A JSON text or an SSE frame never has this shape (`{`,
 * `"` or a space), so a JSON field named `token` is not read as a form field.
 */
const FORM_URLENCODED = /^[A-Za-z0-9_.~*%+\-[\]]+=[^&\s]*(?:&[A-Za-z0-9_.~*%+\-[\]]+=[^&\s]*)*$/;

/**
 * The form shape that form parsers accept (#258). URLSearchParams, undici's
 * `Response.formData()` and Python's `parse_qsl` all read `token` out of a
 * body with a trailing or doubled `&`, a raw space or tab in a value, a
 * trailing newline, a leading BOM, a bare flag (`verbose&token=...`) or an
 * empty name (`=x&token=...`). `FORM_URLENCODED` refused every one of them,
 * so a revocation body built by hand lost the bare `token` rule: the token
 * was sent live and written. So: the ends are trimmed (`trim` also strips a
 * BOM), an empty segment or a name without `=` is a pair, a name may start
 * with a space or BOM, and a value runs to the next `&` or line end. The
 * name's URL-safe characters are what still tell a form from JSON (`{`,
 * `"`), an SSE line (`data:`, a space) and a URL (`:`, `/`, `?`), and an
 * interior line break still ends the form. A request whose recorded
 * `content-type` says form-urlencoded is a form whatever its shape
 * (`FORM_CONTENT_TYPE`).
 */
const FORM_PAIR = String.raw`[ \t\uFEFF]*[A-Za-z0-9_.~*%+\-[\]]*(?:=[^&\r\n]*)?`;
const FORM_PARSED = new RegExp(`^${FORM_PAIR}(?:&${FORM_PAIR})*$`);

/**
 * Whether `v` is a form. A string decoded out of a NON-form string (the
 * remainder of a JSON text after its first `=`, #237) keeps #256's strict
 * shape: under the parsers' shape a remainder such as `===...","top_logprobs":
 * [{"token":"===...` is one pair with an empty name, and the logprobs `token`
 * field inside it would be read as a form field.
 */
function isForm(v: string, strict: boolean): boolean {
  if (strict) return FORM_URLENCODED.test(v);
  return v.includes("=") && FORM_PARSED.test(v.trim());
}

/** A `content-type` header value that says form-urlencoded (#258). */
const FORM_CONTENT_TYPE = /^\s*application\/x-www-form-urlencoded\s*(?:;|$)/i;

/** Whether `headers` (any name case) declare a form-urlencoded body (#258). */
function declaresForm(headers: Record<string, string> | undefined): boolean {
  return Object.entries(headers ?? {}).some(
    ([name, value]) => name.toLowerCase() === "content-type" && FORM_CONTENT_TYPE.test(String(value)),
  );
}

// Where a match was found, and what will actually remove it from there (#151).
// The message used to say "Update redactHeaders() and re-record" for every
// match, but `redactHeaders` only ever sees header NAMES in a fixed list callers
// cannot extend, while #113's pattern exists for the URL and body, which
// `normalizeUrl` and the body canonicalizer record as-is.
//
// The last field says whether every text of that part is a form surface for
// `FORM_SURFACE_PATTERNS` (#256): the URL (its query) and the request headers
// (their names) are; a body or response is one when its recorded
// `content-type` says form-urlencoded (#258), and otherwise only where
// `scanTexts` finds a form inside it.
const LEAK_LOCATIONS: ReadonlyArray<[string, (c: CassetteV1) => unknown, string, (c: CassetteV1) => boolean]> = [
  [
    "the request URL",
    (c) => c.request.url,
    "the query string is recorded as-is; send the credential as a header " +
      "(e.g. `x-goog-api-key`, `api-key`, `authorization`) so redaction strips it",
    () => true,
  ],
  [
    "the request headers",
    (c) => c.request.headers,
    "that header's name is not in the redaction list (SENSITIVE_HEADER_NAMES in " +
      "src/cassette.ts); send the credential under a name it lists, or add the name there",
    () => true,
  ],
  [
    "the request body",
    (c) => c.request.body,
    "the body is recorded verbatim; keep the credential out of it, e.g. in a header",
    (c) => declaresForm(c.request.headers),
  ],
  [
    "the response",
    (c) => c.response,
    "the upstream echoed a credential; record against an endpoint or key that does not",
    (c) => c.response.kind === "non_streaming" && declaresForm(c.response.headers),
  ],
];

/**
 * A base64-stored text as the scanner must read it (#175): its bytes, one
 * character per byte (latin1), so an ASCII credential inside them is visible to
 * the patterns verbatim.
 *
 * Text that is not canonical base64 is kept alongside its decoding (#193).
 * Node's decoder skips every character outside the alphabet, so decoding a
 * hand-edited body marked "base64" discards the text the file actually holds
 * -- a cleartext key included -- and the committed-cassette rescan passed it.
 * Canonical base64 still reads as its bytes only: there the text is just an
 * encoding, and scanning it would refuse bytes whose base64 merely LOOKS like a
 * key. One function for both callers (#229), so the body decode and the
 * FormData `fb` decode cannot drift apart on that rule.
 */
function decodeForScan(b64: string): string {
  const bytes = Buffer.from(b64, "base64");
  const decoded = bytes.toString("latin1");
  return bytes.toString("base64") === b64 ? decoded : `${b64}\n${decoded}`;
}

/**
 * The cassette as the scanner must read it (#175): every base64-stored body
 * decoded by `decodeForScan`. #147 and #173 store a body that is not valid
 * UTF-8 as base64, and the scanner read only that text: a key in such a request
 * or response body was written to the cassette, and the committed-cassette
 * rescan, which calls this function, passed it too.
 */
function scanView(cassette: CassetteV1): CassetteV1 {
  const decode = (b64: unknown): unknown => (typeof b64 === "string" ? decodeForScan(b64) : b64);
  let view = cassette;
  if (cassette.request.bodyEncoding === "base64") {
    view = { ...view, request: { ...view.request, body: decode(view.request.body) } };
  }
  const response = cassette.response;
  if (response.kind === "non_streaming" && response.bodyEncoding === "base64") {
    view = { ...view, response: { ...response, body: decode(response.body) as string } };
  }
  return view;
}

/** How deep `scanTexts` follows JSON nested inside a string (#183). */
const MAX_NESTED_JSON_DEPTH = 4;

/**
 * One multipart part (#243): its `Content-Disposition: form-data` parameters
 * (#247: the whole list, folded continuation lines included), any further
 * header lines, the blank line, and the value up to the next delimiter line
 * (or the end of a truncated body). CRLF or bare LF, as a hand-built body may
 * use either.
 */
const MULTIPART_PART =
  /Content-Disposition:[ \t]*form-data((?:[^\r\n]|\r?\n[ \t])*)\r?\n(?:[^\r\n]+\r?\n)*?\r?\n([\s\S]*?)(?=\r?\n--|$)/gi;

/**
 * Every field name a `Content-Disposition` parameter list gives its part
 * (#247). #245 matched only `form-data; name="..."`: the name quoted and
 * first. An unquoted `name=api_key`, a `filename` before `name`, a space
 * before the `;`, a single-quoted name, a folded header line and RFC 2231
 * `name*=utf-8''api_key` all passed, and Node's own parser reads the first two
 * as a field named `api_key`: the key was sent live and written. So split on
 * `;` outside quotes, take `name` and `name*` wherever they appear, strip a
 * double or single quote pair, and percent-decode `name*` after its
 * `charset'lang'` prefix. A `'` opens a quote only right after `=`, so an
 * apostrophe in an unquoted filename does not swallow the rest.
 *
 * A backslash inside `"…"` is read both ways (#252). RFC 7230's quoted-pair
 * makes `\"` an escaped quote, and Node 20's parser agrees, but Node 25's
 * undici reads the backslash literally: `filename="a\"; name="api_key"` is a
 * field named `api_key` to Node 25 and a filename running to the end to this
 * reader, so the key was sent live and written. The scanner only adds texts,
 * so the names from both readings are kept.
 */
function dispositionNames(params: string): string[] {
  return [...new Set([...readDispositionNames(params, true), ...readDispositionNames(params, false)])];
}

/** `dispositionNames` under one reading of a backslash inside `"…"` (#252). */
function readDispositionNames(params: string, backslashEscapes: boolean): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (quote) {
      if (backslashEscapes && c === "\\" && quote === '"' && i + 1 < params.length) current += c + params[++i];
      else {
        if (c === quote) quote = "";
        current += c;
      }
    } else if (c === ";") {
      parts.push(current);
      current = "";
    } else {
      if (c === '"' || (c === "'" && /=\s*$/.test(current))) quote = c;
      current += c;
    }
  }
  parts.push(current);
  const names: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key !== "name" && key !== "name*") continue;
    let value = part.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, -1);
      if (q === '"' && backslashEscapes) value = value.replace(/\\(.)/g, "$1");
    }
    if (key === "name*") {
      const encoded = value.replace(/^[^']*'[^']*'/, "");
      try {
        value = decodeURIComponent(encoded);
      } catch {
        // A non-UTF-8 charset (`iso-8859-1''%E9`): one byte per escape.
        value = encoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      }
    }
    names.push(value);
  }
  return names;
}

/**
 * Every text the patterns must see in `value` (#183): its serialisation, every
 * string inside it as the string itself, and the same again for any JSON a
 * string holds (a JSON response body, each SSE `data:` payload).
 *
 * Scanning only `JSON.stringify(view)` read a string field the way it is
 * escaped, not what it says. Inside a response body, an SSE frame or a raw
 * request body, `{"access_token":"..."}` serialises as `access_token\":\"...`
 * and the `key=` family allows only an optional quote before the `:`. A
 * newline before `sk-` serialises as `\nsk-`, where the leading `\b` never
 * fires. Both passed: a recorded upstream that echoed a token was written to
 * the cassette and the committed-cassette rescan reported it clean.
 */
function isFormDataRecord(v: unknown[]): boolean {
  const tag = v[0];
  const arity = tag === "s" ? 3 : tag === "f" || tag === "fb" ? 5 : 0;
  return v.length === arity && v.every((item) => typeof item === "string");
}

/**
 * `form` collects the texts that come from a form inside `value` (#256): a
 * string in form-urlencoded shape and its decoded pairs, each multipart part
 * and each FormData record, as `name=value`. Only those, plus the URL and the
 * request headers, are read by `FORM_SURFACE_PATTERNS`.
 */
function scanTexts(value: unknown, form: string[] = [], depth = 0): string[] {
  const out = [JSON.stringify(value) ?? ""];
  const visit = (v: unknown, strict = false): void => {
    if (typeof v === "string") {
      out.push(v);
      const formShaped = isForm(v, strict);
      if (formShaped) form.push(v);
      if (depth >= MAX_NESTED_JSON_DEPTH) return;
      // An SSE line ends at ANY of `\r\n`, `\r` or `\n`, the three forms
      // `captureSse` splits frames on (D-012), and an event's `data:` lines are
      // joined with `\n` (#191). Splitting on `\r?\n` alone left a CR-framed
      // event as one line starting with `event:`, so its payload was never
      // parsed, and each line of a multi-line `data` field failed to parse alone.
      const candidates = [v];
      const data: string[] = [];
      const lines = v.split(/\r\n|\r|\n/);
      for (const line of lines) {
        // Each line of a multi-line string is also a candidate (#223): an NDJSON
        // body, and a FormData body, which the recorder stores as one JSON
        // record per entry joined with `\n`. With two or more lines the whole
        // string is not JSON, so without this a record's escaped value was
        // never read as what it says.
        if (lines.length > 1) candidates.push(line);
        if (!line.startsWith("data:")) continue;
        candidates.push(line.slice(5).trim());
        data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
      if (data.length > 1) candidates.push(data.join("\n"));
      for (const text of candidates) {
        const t = text.trim();
        if (!(t.startsWith("{") || t.startsWith("["))) continue;
        try {
          out.push(...scanTexts(JSON.parse(t), form, depth + 1));
        } catch {
          // Not JSON: the string itself was already pushed.
        }
      }
      // A form-urlencoded string is also read as what it says (#237): a URL,
      // whose query `normalizeUrl` rebuilds with `searchParams.append`, and a
      // `URLSearchParams` body, stored as its `toString()`. Both encode `/` as
      // `%2F`, `+` as `%2B`, `=` as `%3D` and a space as `+`, so the `key=`
      // family stopped at the first `%` and `Bearer\s+` never matched
      // `Bearer+`: the key was written and the committed-cassette rescan passed
      // it. #183 decoded JSON escapes and never this one. Shape, not
      // content-type: the recorder does not keep the content-type fetch sets
      // for a `URLSearchParams` body, and decoding only adds texts. Without a
      // `%` or `+` the decoding is the string itself. Each value is visited, so
      // a `Bearer`/`Basic` value or encoded JSON is read too; it is shorter than
      // `v`, so this ends.
      if (v.includes("=") && /[%+]/.test(v)) {
        for (const [name, decoded] of new URLSearchParams(v)) {
          out.push(`${name}=${decoded}`);
          if (formShaped) form.push(`${name}=${decoded}`);
          visit(decoded, !formShaped);
        }
      }
      // A multipart body is also read part by part (#243). The recorder parses
      // undici's own FormData serialization into records (#231), but a body
      // whose parse does not round-trip -- a File with an empty filename, a
      // field name holding a literal `%0A`, Node 20's parser moving string
      // fields ahead of files -- keeps its wire bytes (#235), as does every
      // hand-built multipart body. There a field reads `name="api_key"`, a
      // blank line and the value, which the `key=` family never matches: the
      // key was sent live and written. Emit `name=value` per part, by shape as
      // above; it only adds texts, and each value is shorter than `v`. Every
      // name the parameter list gives, in any spelling (#247).
      if (/form-data/i.test(v)) {
        for (const [, params, value] of v.matchAll(MULTIPART_PART)) {
          for (const name of dispositionNames(params)) {
            out.push(`${name}=${value}`);
            form.push(`${name}=${value}`);
          }
          visit(value);
        }
      }
    } else if (Array.isArray(v)) {
      // A FormData record (#223), `["s", name, value]` or
      // `["f"|"fb", name, filename, type, text]`, puts `","` between the field
      // name and its value, which the `key=` family never matches. A bare
      // 32-hex or opaque token has no prefix for any other pattern, so an
      // `api_key` field was written to the cassette. Also emit `name=value`.
      if (isFormDataRecord(v)) {
        out.push(`${v[1]}=${v[v.length - 1]}`);
        form.push(`${v[1]}=${v[v.length - 1]}`);
      }
      // An `fb` record's last field is base64 (#147): a FormData file that is
      // not valid UTF-8. Its body is `json` (one entry) or `raw` (several), never
      // `base64`, so `scanView` never decoded it, and a key in such a file was
      // sent live, written, and passed the committed-cassette rescan -- while
      // the same bytes as a Uint8Array or Blob body were refused (#229). Read it
      // as its bytes, by the rule `scanView` uses. No `name=bytes` as well: the
      // `name=base64` above already matches the `key=` family for any payload
      // of 18+ bytes, and a 24-char token is longer than that.
      if (isFormDataRecord(v) && v[0] === "fb") out.push(decodeForScan(v[4] as string));
      for (const item of v) visit(item);
    } else if (v !== null && typeof v === "object") {
      // Keys too (#238): a key was read only through `JSON.stringify`, where an
      // escape such as `\n` before `sk-` kills the leading `\b` -- the gap #183
      // closed for values. A map keyed by free text puts a credential there.
      for (const [key, item] of Object.entries(v)) {
        visit(key);
        visit(item);
      }
    }
  };
  visit(value);
  return out;
}

/**
 * `value`'s texts, and the subset `FORM_SURFACE_PATTERNS` may read (#256):
 * all of them when `value` is itself a form surface (the URL, the request
 * headers, a body declared form-urlencoded), otherwise the forms `scanTexts`
 * finds inside it.
 */
function surfaceTexts(value: unknown, isFormSurface: boolean): { all: string[]; form: string[] } {
  const form: string[] = [];
  const all = scanTexts(value, form);
  return { all, form: isFormSurface ? all : form };
}

export function assertNoLeakedSecrets(cassette: CassetteV1): void {
  const view = scanView(cassette);
  const whole = surfaceTexts(view, false);
  const form = [...whole.form];
  for (const [, part, , isFormSurface] of LEAK_LOCATIONS) if (isFormSurface(view)) form.push(...scanTexts(part(view)));
  const checks: Array<[RegExp, "all" | "form"]> = [
    ...API_KEY_PATTERNS.map((p): [RegExp, "all"] => [p, "all"]),
    ...FORM_SURFACE_PATTERNS.map((p): [RegExp, "form"] => [p, "form"]),
  ];
  for (const [pattern, surface] of checks) {
    if (!(surface === "all" ? whole.all : form).some((t) => pattern.test(t))) continue;
    const found = LEAK_LOCATIONS.find(([, part, , isFormSurface]) =>
      surfaceTexts(part(view), isFormSurface(view))[surface].some((t) => pattern.test(t)),
    );
    const where = found ? ` in ${found[0]}` : "";
    const advice = found ? ` ${found[2]}, then re-record.` : " Remove it, then re-record.";
    throw new Error(
      `cassette appears to contain an unredacted secret matching ${pattern.source}${where}; ` +
        `refusing to write.${advice}`,
    );
  }
}
