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
  if (bodyText !== null && bodyText.length > 0) {
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      // Non-JSON body: hash on the raw bytes by storing as a string.
      parsedBody = { __raw_body__: bodyText };
    }
  }

  const normalized: NormalizedRequest = {
    method,
    url: normalizeUrl(url),
    headers: redactHeaders(rawHeaders),
    body: canonicalize(parsedBody),
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
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    // Skip ReadableStream / FormData / Blob — too varied to canonicalize.
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

    // Re-issue the original request to upstream. Body might have been consumed
    // above, so reconstruct from bodyText if present.
    const upstreamInit: RequestInit = {
      ...init,
      method: normalized.method,
      body: bodyText ?? init?.body ?? undefined,
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
      cloneForCaller = new Response(replayBody, {
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
      cloneForCaller = new Response(text, {
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
    return new Response(recorded.body, { status: recorded.status, headers });
  }

  // SSE: stream frames in order with no synthetic delay (deterministic-by-default).
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of recorded.frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: recorded.status, headers });
}
