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
      for (const [k, v] of headers) out[k.toLowerCase()] = v;
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

/* ------------------------------------------------------------------ */
/* Recorder                                                            */
/* ------------------------------------------------------------------ */

export function createRecorderFetch(opts: RecorderOptions): typeof fetch {
  const upstream = opts.upstream ?? globalThis.fetch;

  return async function recorderFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!shouldIntercept(url, opts.hosts)) {
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
  return async function replayerFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!shouldIntercept(url, opts.hosts)) {
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
