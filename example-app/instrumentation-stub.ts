/**
 * Deterministic Anthropic-API stub for Playwright (#2).
 *
 * Intercepts ``globalThis.fetch`` calls to ``api.anthropic.com/v1/messages``
 * and emits one of three canned SSE streams depending on the user prompt:
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
    const scenario = pickScenario(prompt);

    return sseResponse(scenario);
  }) as typeof fetch;
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
