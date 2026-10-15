/**
 * Deterministic Anthropic-API stub for Playwright (#2).
 *
 * Intercepts ``globalThis.fetch`` calls to ``api.anthropic.com/v1/messages``.
 * A non-streaming call (no ``stream: true``) gets a JSON message, the way the
 * API answers it (#209): a 404 ``not_found_error`` for an unknown model, a
 * ``tool_use`` turn (``calculate`` for an arithmetic prompt, else
 * ``get_weather``) then an ``end_turn`` answer when ``tools`` is set, and a
 * plain text message otherwise. A streaming call gets one of three canned SSE
 * streams depending on the user prompt:
 *
 *   - prompt contains "short"  → 5-frame stream, terminates ~50 ms in.
 *   - prompt contains "error"  → frame sequence aborts with an HTTP-500
 *     style ``message`` event the SDK surfaces as a thrown error, which
 *     the streaming route forwards as an ``event: error`` SSE frame.
 *   - otherwise (long)         → 32-frame stream, terminates ~400 ms in.
 *
 * The streams use the minimum SSE event sequence the SDK needs to surface
 * a text stream (`message_start` → `content_block_start` → repeated
 * `content_block_delta` → `content_block_stop` → `message_stop`). The
 * inter-frame delay is real (`await new Promise(setTimeout, ...)`) so the
 * client-side phase machine observes the same `first-token → streaming`
 * transition shape it would see against a live model.
 *
 * Why globalThis.fetch (and not the toolkit's cassette layer): the
 * cassette layer hashes the exact request body, which requires either a
 * real recording or a hand-computed hash that drifts on SDK upgrades. For
 * three deterministic streams a prompt-routed stub is simpler and lets
 * the cassette layer keep its own scope (in-process route tests + the
 * `installFromEnv()` recorder mode).
 */

const ORIGINAL_FETCH = globalThis.fetch;
const TARGET_HOST = "api.anthropic.com";

let installed = false;

export function installPlaywrightStub(): void {
  if (installed) return;
  installed = true;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    let host: string | null = null;
    try {
      host = new URL(url).hostname;
    } catch {
      host = null;
    }

    if (host !== TARGET_HOST) {
      return ORIGINAL_FETCH(input as any, init);
    }

    // Pull the prompt out of the request body to route to the right canned stream.
    const bodyText = await readBodyAsText(input, init);
    const prompt = extractPrompt(bodyText);

    // A non-streaming call gets JSON, as the API answers it (#209). Every
    // request used to get the canned SSE stream, which the SDK reads as the
    // text of a non-streaming response: `/api/tools` saw
    // `stop_reason=undefined` and 502'd on every query, and `/api/error`'s
    // bad-model call "succeeded". Streaming requests are untouched below.
    const request = parseRequest(bodyText);
    if (request !== null && request.stream !== true) {
      return messageResponse(request, prompt);
    }

    const scenario = pickScenario(prompt);
    return sseResponse(scenario);
  }) as typeof fetch;
}

/**
 * The models the stub answers as. Any other id gets the 404
 * `not_found_error` the real API returns for an unknown model, which is what
 * `/api/error`'s `upstream` case exists to show.
 */
const KNOWN_MODELS = new Set(["claude-haiku-4-5-20251001"]);

const STUB_MODEL = "claude-haiku-4-5-20251001";

interface StubRequest {
  model?: unknown;
  stream?: unknown;
  tools?: unknown;
  messages?: Array<{ role?: string; content?: unknown }>;
}

function parseRequest(bodyText: string | null): StubRequest | null {
  if (bodyText === null) return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as StubRequest;
  } catch {
    return null;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_stub" },
  });
}

function messageResponse(request: StubRequest, prompt: string | null): Response {
  if (typeof request.model !== "string" || !KNOWN_MODELS.has(request.model)) {
    return jsonResponse(404, {
      type: "error",
      error: { type: "not_found_error", message: `model: ${String(request.model)}` },
      request_id: "req_stub",
    });
  }
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
  if (!hasTools) {
    return jsonResponse(200, message([{ type: "text", text: "Stub answer." }], "end_turn"));
  }
  // Once the tool's result is back, answer with it; otherwise call a tool.
  const result = lastToolResult(request.messages);
  if (result !== null) {
    return jsonResponse(
      200,
      message([{ type: "text", text: `The ${result.name} tool returned ${result.content}.` }], "end_turn"),
    );
  }
  const expression = prompt === null ? null : arithmeticIn(prompt);
  const toolUse =
    expression !== null
      ? { type: "tool_use", id: "toolu_stub_0", name: "calculate", input: { expression } }
      : { type: "tool_use", id: "toolu_stub_0", name: "get_weather", input: { city: cityIn(prompt) } };
  return jsonResponse(200, message([toolUse], "tool_use"));
}

function message(content: unknown[], stopReason: string): Record<string, unknown> {
  return {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: STUB_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/** The longest run of digits joined by at least one operator, e.g. `17 * 23`. */
function arithmeticIn(prompt: string): string | null {
  const matches = prompt.match(/[0-9(][0-9+\-*/(). ]*[0-9)]/g) ?? [];
  const exprs = matches.map((m) => m.trim()).filter((m) => /[0-9)]\s*[+\-*/]\s*[0-9(]/.test(m));
  if (exprs.length === 0) return null;
  return exprs.reduce((a, b) => (b.length > a.length ? b : a));
}

function cityIn(prompt: string | null): string {
  const m = prompt?.match(/\bin\s+([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*)/);
  return m?.[1] ?? "Paris";
}

/** The tool name and result content of the last `tool_result`, or null. */
function lastToolResult(
  messages: StubRequest["messages"],
): { name: string; content: string } | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last?.role !== "user" || !Array.isArray(last.content)) return null;
  const block = (last.content as Array<Record<string, unknown>>).find(
    (b) => typeof b === "object" && b !== null && b.type === "tool_result",
  );
  if (block === undefined) return null;
  const id = block.tool_use_id;
  let name = "requested";
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b?.type === "tool_use" && b.id === id && typeof b.name === "string") name = b.name;
    }
  }
  const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
  return { name, content };
}

type Scenario = "short" | "long" | "error";

function pickScenario(prompt: string | null): Scenario {
  if (prompt === null) return "long";
  const lowered = prompt.toLowerCase();
  if (lowered.includes("error")) return "error";
  if (lowered.includes("short")) return "short";
  return "long";
}

function sseResponse(scenario: Scenario): Response {
  const frames = framesFor(scenario);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const f of frames) {
        controller.enqueue(encoder.encode(f.text));
        if (f.delayMs > 0) {
          await new Promise((r) => setTimeout(r, f.delayMs));
        }
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

interface Frame {
  text: string;
  delayMs: number;
}

function framesFor(scenario: Scenario): Frame[] {
  if (scenario === "short") {
    return buildFrames(["Hi.", " There."], { interFrameMs: 25 });
  }
  if (scenario === "error") {
    // message_start then a stream-level error frame the SDK surfaces.
    return [
      { text: sseFrame("message_start", messageStart()), delayMs: 10 },
      {
        text: sseFrame("error", {
          type: "error",
          error: { type: "overloaded_error", message: "stub-induced error stream" },
        }),
        delayMs: 0,
      },
    ];
  }
  // long: 32 chunks of a deterministic essay, ~12 ms apart -> ~400 ms total.
  const chunks: string[] = [];
  for (let i = 0; i < 32; i++) {
    chunks.push(`token-${i.toString().padStart(2, "0")} `);
  }
  return buildFrames(chunks, { interFrameMs: 12 });
}

function buildFrames(chunks: string[], opts: { interFrameMs: number }): Frame[] {
  const out: Frame[] = [];
  out.push({ text: sseFrame("message_start", messageStart()), delayMs: opts.interFrameMs });
  out.push({
    text: sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    delayMs: 0,
  });
  for (const chunk of chunks) {
    out.push({
      text: sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunk },
      }),
      delayMs: opts.interFrameMs,
    });
  }
  out.push({
    text: sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    delayMs: 0,
  });
  out.push({
    text: sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: chunks.length },
    }),
    delayMs: 0,
  });
  out.push({ text: sseFrame("message_stop", { type: "message_stop" }), delayMs: 0 });
  return out;
}

function messageStart(): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  };
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readBodyAsText(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | null> {
  if (init?.body !== undefined && init.body !== null) {
    const b = init.body;
    if (typeof b === "string") return b;
    if (b instanceof Uint8Array) return new TextDecoder().decode(b);
    if (b instanceof ArrayBuffer) return new TextDecoder().decode(b);
    return null;
  }
  if (typeof input === "object" && "clone" in input && typeof input.clone === "function") {
    try {
      return await (input as Request).clone().text();
    } catch {
      return null;
    }
  }
  return null;
}

function extractPrompt(bodyText: string | null): string | null {
  if (bodyText === null) return null;
  try {
    const parsed = JSON.parse(bodyText) as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const user = parsed.messages?.find((m) => m.role === "user");
    if (!user) return null;
    if (typeof user.content === "string") return user.content;
    if (Array.isArray(user.content)) {
      const text = user.content
        .map((b) => (typeof b === "object" && b !== null && "text" in (b as Record<string, unknown>)
          ? (b as { text?: string }).text
          : null))
        .filter((s): s is string => typeof s === "string")
        .join(" ");
      return text || null;
    }
    return null;
  } catch {
    return null;
  }
}
