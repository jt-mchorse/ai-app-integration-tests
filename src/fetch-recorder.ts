import {
  type CassetteV1,
  type NormalizedRequest,
  type RecordedResponse,
  assertNoLeakedSecrets,
  canonicalize,
  hashRequest,
  normalizeUrl,
  redactHeaders,
} from "./cassette.js";
import { CassetteStore } from "./io.js";

export interface RecorderOptions {
  /** Underlying fetch to delegate to. Defaults to global fetch. */
  upstream?: typeof fetch;
  /** Cassette store. */
  store: CassetteStore;
  /** Hostnames to intercept; everything else passes through unchanged. */
  hosts: ReadonlySet<string>;
}

export interface ReplayerOptions {
  store: CassetteStore;
  hosts: ReadonlySet<string>;
}

/* ------------------------------------------------------------------ */
/* Shared request normalization                                        */
/* ------------------------------------------------------------------ */

async function normalizeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ normalized: NormalizedRequest; rawHeaders: Record<string, string>; bodyText: string | null }> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();

  const rawHeaders = collectHeaders(init?.headers, input);
  const bodyText = await readBodyAsText(init?.body, input);

  let parsedBody: unknown = null;
  let bodyEncoding: "json" | "raw" | undefined;
  if (bodyText !== null) {
    if (bodyText.length > 0) {
      try {
        parsedBody = JSON.parse(bodyText);
        bodyEncoding = "json";
      } catch {
        // Non-JSON body: hash on the raw text directly, tagged bodyEncoding:"raw"
        // so it can never collide with a JSON body of the same canonical shape
        // (#57). The old `{ __raw_body__: bodyText }` wrapper collided with a
        // literal JSON `{"__raw_body__": bodyText}` once canonicalized; storing
        // the plain text plus the out-of-body discriminator removes the whole
        // collision class.
        parsedBody = bodyText;
        bodyEncoding = "raw";
      }
    } else {
      // An explicit empty-string body (`fetch(url, { method: "POST", body: "" })`)
      // is a PRESENT body — a POST with Content-Length: 0 is a different wire
      // request than one with no body at all. The old `&& bodyText.length > 0`
      // guard left this as `parsedBody: null` / `bodyEncoding: undefined`, byte-
      // identical to a no-body request, so the two hash-collided and a no-body
      // request could replay the empty-body cassette (and vice-versa). Tag it
      // `raw` (an empty string is not valid JSON) so it stays distinct from
      // no-body — exactly as #70 split a JSON-`null` body from a no-body request
      // (sibling of #57/#70/#71).
      parsedBody = bodyText;
      bodyEncoding = "raw";
    }
  }

  const normalized: NormalizedRequest = {
    method,
    url: normalizeUrl(url),
    headers: redactHeaders(rawHeaders),
    body: canonicalize(parsedBody),
    ...(bodyEncoding ? { bodyEncoding } : {}),
  };

  return { normalized, rawHeaders, bodyText };
}

function collectHeaders(headers: HeadersInit | undefined, input: RequestInfo | URL): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof input === "object" && "headers" in input && input.headers) {
    input.headers.forEach((v: string, k: string) => {
      out[k.toLowerCase()] = v;
    });
  }
  if (headers) {
    if (headers instanceof Headers) {
      headers.forEach((v: string, k: string) => {
        out[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(headers)) {
      // Coerce to string like the object path below: an untyped (JS) caller can
      // pass a non-string value (e.g. `[["x-count", 5]]`), and the
      // `Record<string, string>` return type — plus cassette JSON round-trip and
      // request hashing — require a string. Without this the array path stored a
      // raw number, corrupting `request.headers` and causing a spurious cassette
      // miss vs a string-valued match. (#52)
      for (const [k, v] of headers) out[k.toLowerCase()] = String(v);
    } else {
      for (const [k, v] of Object.entries(headers)) {
        out[k.toLowerCase()] = String(v);
      }
    }
  }
  return out;
}

async function readBodyAsText(
  body: BodyInit | null | undefined,
  input: RequestInfo | URL,
): Promise<string | null> {
  if (body !== undefined && body !== null) {
    if (typeof body === "string") return body;
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) {
      // Any ArrayBufferView is a standard BodyInit that fetch sends as its exact
      // bytes: Uint8Array, but also DataView, Int8Array, Uint16Array/Int16Array,
      // Float32Array/Float64Array, a Node Buffer, etc. Previously only Uint8Array
      // was decoded; every OTHER view fell through to `null` (below), so a typed-
      // array body looked byte-identical to a no-body request — two distinct
      // Int16Array bodies hash-collided and one replayed the other's cassette, and
      // a view-body POST collided with a no-body POST. `TextDecoder().decode`
      // accepts any BufferSource and honors the view's byteOffset/byteLength
      // window, so normalizeRequest tags it `bodyEncoding:"raw"` and folds it into
      // the hash — the same collision class as #86 (URLSearchParams) / #84 (empty-
      // string) / #70 (JSON-null) / #57 (raw/JSON), one body-type over.
      return new TextDecoder().decode(body);
    }
    if (body instanceof URLSearchParams) {
      // A URLSearchParams body is a standard BodyInit that fetch serializes onto
      // the wire as `application/x-www-form-urlencoded` — `toString()` is exactly
      // those bytes. Dropping it to `null` (below) left every form POST looking
      // like a no-body request, so two distinct form bodies (`foo=1` vs `bar=2`)
      // hash-collided and one replayed the other's cassette, and a form POST
      // collided with a no-body POST. Return the encoded text so normalizeRequest
      // tags it `bodyEncoding:"raw"` and folds it into the hash — the same
      // collision class as #84 (empty-string) / #70 (JSON-null) / #57 (raw/JSON),
      // one body-type over.
      return body.toString();
    }
    if (body instanceof Blob) {
      // A Blob body is a standard BodyInit that fetch serializes to its exact,
      // fixed bytes — `await body.text()` reads them deterministically. It has no
      // random "boundary" (that concept applies to multipart FormData, not a plain
      // Blob) and, unlike a ReadableStream, is not single-read. Dropping it to
      // `null` (below) left every Blob POST looking like a no-body request, so two
      // distinct Blob bodies (`new Blob(["a"])` vs `new Blob(["b"])`) hash-collided
      // and one replayed the other's cassette, and a Blob POST collided with a
      // no-body POST. Decode it so normalizeRequest tags it `bodyEncoding:"raw"`
      // and folds it into the hash — the same collision class as #88 (typed-array
      // views) / #86 (URLSearchParams) / #84 (empty-string), one body-type over.
      // `File extends Blob`, so a File body is covered by this branch too.
      return await body.text();
    }
    if (body instanceof FormData) {
      // A FormData body used to be lumped in with ReadableStream and dropped to
      // `null`, on the grounds that it "serializes to a multipart body with a
      // random boundary". The boundary is real, but it is a property of the
      // *serialized bytes*, and the hash never uses serialized bytes — it
      // canonicalizes the LOGICAL body. That is exactly why `URLSearchParams`
      // above is hashed via `toString()` rather than by capturing what `fetch`
      // actually framed onto the wire.
      //
      // FormData's logical body is `[...entries()]`: deterministic,
      // insertion-ordered, duplicate-key preserving, and re-readable (unlike a
      // stream, reading it here does not consume it, so the same object still
      // reaches the upstream fetch). Dropping it to `null` made every FormData
      // POST byte-identical to a no-body request, so two distinct form bodies
      // hash-collided and one replayed the other's cassette (#92).
      //
      // Each entry is emitted as a tagged JSON record so a string value can't
      // be confused with a File carrying the same field name, and so a file's
      // name/type participate in the hash alongside its bytes. `File extends
      // Blob`, so `.text()` reads it deterministically — the same property the
      // Blob branch above relies on.
      const records: string[] = [];
      for (const [name, value] of body.entries()) {
        records.push(
          typeof value === "string"
            ? JSON.stringify(["s", name, value])
            : JSON.stringify(["f", name, value.name, value.type, await value.text()]),
        );
      }
      return records.join("\n");
    }
    // Skip ReadableStream — genuinely un-canonicalizable here, because it is
    // single-read: consuming it to hash it would take the body away from the
    // upstream request. It still drops to null; a request whose only body is a
    // stream is out of scope for hashing (a documented limitation, unlike the
    // URLSearchParams / Blob / FormData gaps above, which were all bugs).
    return null;
  }
  if (typeof input === "object" && "clone" in input && typeof input.clone === "function") {
    try {
      const cloned = (input as Request).clone();
      return await cloned.text();
    } catch {
      return null;
    }
  }
  return null;
}

function shouldIntercept(url: string, hosts: ReadonlySet<string>): boolean {
  try {
    const u = new URL(url);
    return hosts.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Lower-case every host so matching is case-insensitive. `URL.hostname` is
 * always lower-cased by the WHATWG parser and hostnames are case-insensitive
 * (RFC 3986 §3.2.2), but caller-supplied hosts are taken verbatim — a
 * mixed-/upper-case entry like `API.ANTHROPIC.COM` would never match the
 * lower-cased `u.hostname` and silently degrade the recorder to pass-through.
 * Built once per factory so the per-request `shouldIntercept` stays a plain
 * Set lookup.
 */
function normalizeHosts(hosts: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...hosts].map((h) => h.toLowerCase()));
}

/* ------------------------------------------------------------------ */
/* Factory-layer entry validation (#34)                                */
/* ------------------------------------------------------------------ */

/**
 * Duck-typed shape check: anything carrying `read` + `write` functions
 * satisfies the factory's contract with `CassetteStore`. We don't
 * `instanceof CassetteStore` because doing so would force the factory
 * to import the concrete class, which is otherwise opaque here.
 */
function isStoreLike(store: unknown): boolean {
  if (store === null || typeof store !== "object") return false;
  const s = store as { read?: unknown; write?: unknown };
  return typeof s.read === "function" && typeof s.write === "function";
}

function validateHosts(hosts: ReadonlySet<string> | undefined, fnName: string): void {
  if (!(hosts instanceof Set)) {
    throw new Error(
      `${fnName}: hosts must be a Set of hostnames; got ${
        hosts === undefined ? "undefined" : typeof hosts
      }`,
    );
  }
  if (hosts.size === 0) {
    throw new Error(
      `${fnName}: hosts must be a non-empty Set; got an empty Set. ` +
        `An empty hosts Set silently degrades the recorder to pass-through ` +
        `(every fetch hits upstream, no cassette is written) — the worst shape ` +
        `for this repo's purpose. Pass at least one hostname, or use the ` +
        `higher-level installRecorder/installReplayer which defaults to ` +
        `["api.anthropic.com"].`,
    );
  }
  let i = 0;
  for (const h of hosts) {
    if (typeof h !== "string" || h.length === 0) {
      throw new Error(
        `${fnName}: hosts entry #${i} must be a non-empty string; got ${JSON.stringify(h)}`,
      );
    }
    i++;
  }
}

/**
 * Validate `opts` at the entry of `createRecorderFetch` (#34).
 *
 * Sibling to `validateHosts` in `src/install.ts` (#26) — that gate
 * lives at the installer layer; this one closes the same silent-
 * pass-through harm class at the factory layer below, where a direct
 * caller (custom embed, alt install path) bypasses the installer
 * entry.
 */
export function validateRecorderOptions(opts: RecorderOptions): void {
  if (!isStoreLike(opts.store)) {
    throw new Error(
      "createRecorderFetch: opts.store must be a CassetteStore-like " +
        "object with read() and write() methods",
    );
  }
  validateHosts(opts.hosts, "createRecorderFetch");
}

/** Sibling of `validateRecorderOptions` for the replayer factory (#34). */
export function validateReplayerOptions(opts: ReplayerOptions): void {
  if (!isStoreLike(opts.store)) {
    throw new Error(
      "createReplayerFetch: opts.store must be a CassetteStore-like " +
        "object with read() and write() methods",
    );
  }
  validateHosts(opts.hosts, "createReplayerFetch");
}

/* ------------------------------------------------------------------ */
/* Recorder                                                            */
/* ------------------------------------------------------------------ */

/**
 * Per the Fetch spec a "null body status" (204 No Content, 205 Reset Content,
 * 304 Not Modified) forbids ANY response body: the `Response` constructor throws
 * a `TypeError` even for an empty-string body — only `null` is accepted. Recorded
 * and replayed bodies for these statuses are always `""`, so every
 * `new Response(body, { status })` site must coerce the body to `null` or the
 * recorder/replayer crashes on a perfectly valid 204 (e.g. a DELETE) instead of
 * round-tripping it.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

function bodyForStatus<T>(status: number, body: T): T | null {
  return NULL_BODY_STATUSES.has(status) ? null : body;
}

export function createRecorderFetch(opts: RecorderOptions): typeof fetch {
  validateRecorderOptions(opts);
  const upstream = opts.upstream ?? globalThis.fetch;
  const hosts = normalizeHosts(opts.hosts);

  return async function recorderFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!shouldIntercept(url, hosts)) {
      return upstream(input, init);
    }

    const { normalized, bodyText } = await normalizeRequest(input, init);
    const requestHash = hashRequest(normalized);

    // Re-issue the original request to upstream, forwarding the caller's own
    // body object whenever there is one.
    //
    // This used to prefer `bodyText`, justified as "the body might have been
    // consumed above". None of the `init.body` branches in `readBodyAsText`
    // consume anything — string, ArrayBuffer, any ArrayBufferView,
    // URLSearchParams and FormData are all re-readable, and Blob is a fixed
    // byte container. The only consuming path is `input.clone().text()`, which
    // handles a `Request` input, and there `init?.body` is undefined anyway —
    // so `bodyText` is exactly the right fallback and exactly the wrong default.
    //
    // While only string bodies were decoded this was invisible (`bodyText ===
    // init.body`). Once #86/#88/#90 taught the decoder about URLSearchParams,
    // views and Blobs, it started degrading real requests: a binary body went
    // upstream as `TextDecoder` output, with every non-UTF-8 byte replaced by
    // U+FFFD, so the live API received corrupted bytes and the cassette
    // faithfully recorded the response to a request the caller never made
    // (#93). A URLSearchParams or Blob body also lost the `Content-Type` fetch
    // sets automatically for it and does not set for a string.
    const upstreamInit: RequestInit = {
      ...init,
      method: normalized.method,
      body: init?.body ?? bodyText ?? undefined,
    };
    const liveResponse = await upstream(input, upstreamInit);

    const contentType = liveResponse.headers.get("content-type") ?? "";
    let recorded: RecordedResponse;
    let cloneForCaller: Response;

    if (contentType.includes("text/event-stream")) {
      const { frames, replayBody } = await captureSse(liveResponse);
      recorded = {
        kind: "sse",
        status: liveResponse.status,
        headers: redactHeaders(headersToObject(liveResponse.headers)),
        frames,
      };
      cloneForCaller = new Response(bodyForStatus(liveResponse.status, replayBody), {
        status: liveResponse.status,
        statusText: liveResponse.statusText,
        headers: liveResponse.headers,
      });
    } else {
      const text = await liveResponse.text();
      recorded = {
        kind: "non_streaming",
        status: liveResponse.status,
        headers: redactHeaders(headersToObject(liveResponse.headers)),
        body: text,
      };
      cloneForCaller = new Response(bodyForStatus(liveResponse.status, text), {
        status: liveResponse.status,
        statusText: liveResponse.statusText,
        headers: liveResponse.headers,
      });
    }

    const cassette: CassetteV1 = {
      schema_version: "1",
      request_hash: requestHash,
      request: normalized,
      response: recorded,
      recorded_at: new Date().toISOString(),
    };

    assertNoLeakedSecrets(cassette);
    await opts.store.write(cassette);

    return cloneForCaller;
  };
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

async function captureSse(r: Response): Promise<{ frames: string[]; replayBody: string }> {
  if (!r.body) return { frames: [], replayBody: "" };
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: string[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep + 2);
      buf = buf.slice(sep + 2);
      frames.push(frame);
    }
  }
  // Flush the decoder: with `stream: true` an incomplete trailing multibyte
  // UTF-8 sequence stays buffered inside it. Without this final `decode()` it
  // would be silently dropped from the recorded body; flushing emits the
  // standard U+FFFD replacement char so a truncated stream isn't lost.
  buf += decoder.decode();
  if (buf.length > 0) frames.push(buf);

  const replayBody = frames.join("");
  return { frames, replayBody };
}

/* ------------------------------------------------------------------ */
/* Replayer                                                            */
/* ------------------------------------------------------------------ */

export class MissingCassetteError extends Error {
  constructor(
    public readonly requestHash: string,
    public readonly url: string,
  ) {
    super(
      `no cassette found for ${url} (hash ${requestHash}). ` +
        `In replay mode this is fatal — re-record by running the suite with ANTHROPIC_TEST_MODE=record.`,
    );
    this.name = "MissingCassetteError";
  }
}

export function createReplayerFetch(opts: ReplayerOptions): typeof fetch {
  validateReplayerOptions(opts);
  const hosts = normalizeHosts(opts.hosts);
  return async function replayerFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!shouldIntercept(url, hosts)) {
      // Pass-through to a noop is dangerous in replay mode — we don't want
      // tests accidentally hitting non-intercepted hosts. Throw loudly.
      throw new Error(
        `replayer received request to non-intercepted host ${url}. ` +
          `Either add the hostname to ReplayerOptions.hosts, or change the test to not call it.`,
      );
    }

    const { normalized } = await normalizeRequest(input, init);
    const requestHash = hashRequest(normalized);
    const cassette = await opts.store.read(requestHash);
    if (!cassette) {
      throw new MissingCassetteError(requestHash, url);
    }

    return rebuildResponse(cassette.response);
  };
}

function rebuildResponse(recorded: RecordedResponse): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(recorded.headers)) {
    if (k === "content-encoding" || k === "content-length") continue;
    headers.set(k, v);
  }

  if (recorded.kind === "non_streaming") {
    return new Response(bodyForStatus(recorded.status, recorded.body), {
      status: recorded.status,
      headers,
    });
  }

  // SSE: stream frames in order with no synthetic delay (deterministic-by-default).
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of recorded.frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(bodyForStatus(recorded.status, stream), { status: recorded.status, headers });
}
