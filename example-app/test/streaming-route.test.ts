/**
 * Test the /api/streaming route handler in-process.
 *
 * The Anthropic SDK uses `globalThis.fetch`; we monkey-patch it to emit a
 * canned SSE-style response so the handler runs without an API key or
 * network. This is the same pattern the toolkit's cassette layer
 * implements at a higher level — here we bypass the cassette and pin
 * the route's behavior against a known wire shape.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../app/api/streaming/route.js";

const ORIGINAL_FETCH = globalThis.fetch;

function fakeAnthropicStreamResponse(textChunks: string[]): Response {
  // Anthropic streaming uses SSE with `message_start`, then
  // `content_block_start` / `content_block_delta` per chunk, then
  // `content_block_stop` / `message_stop`. Mimic the minimum the SDK
  // requires to surface a text stream.
  const frames: string[] = [];
  frames.push(
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
  );
  frames.push(
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  );
  for (const chunk of textChunks) {
    frames.push(
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunk },
      }),
    );
  }
  frames.push(
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
  );
  frames.push(
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: textChunks.length },
    }),
  );
  frames.push(sse("message_stop", { type: "message_stop" }));

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readAllSse(resp: Response): Promise<string[]> {
  const reader = resp.body?.getReader();
  if (!reader) return [];
  const dec = new TextDecoder();
  let buf = "";
  const frames: string[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      frames.push(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  return frames;
}

function dataPayloads(frames: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const f of frames) {
    const dataLine = f
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    out.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
  }
  return out;
}

describe("/api/streaming", () => {
  beforeEach(() => {
    globalThis.fetch = (async () =>
      fakeAnthropicStreamResponse(["Hello", " ", "world", "."])) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("returns text/event-stream", async () => {
    const resp = await POST(
      new Request("http://localhost/api/streaming", {
        method: "POST",
        body: JSON.stringify({ prompt: "say hi" }),
      }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/event-stream/);
  });

  it("emits one data frame per text_delta in order", async () => {
    const resp = await POST(
      new Request("http://localhost/api/streaming", {
        method: "POST",
        body: JSON.stringify({ prompt: "say hi" }),
      }),
    );
    const frames = await readAllSse(resp);
    const dataFrames = frames.filter((f) => !f.startsWith("event:"));
    const doneFrames = frames.filter((f) => f.startsWith("event: done"));
    // 4 deltas + 1 done frame.
    expect(dataFrames).toHaveLength(4);
    expect(doneFrames).toHaveLength(1);
    const texts = dataPayloads(dataFrames).map((p) => p.text);
    expect(texts).toEqual(["Hello", " ", "world", "."]);
  });

  it("done frame carries an ms field", async () => {
    const resp = await POST(
      new Request("http://localhost/api/streaming", {
        method: "POST",
        body: JSON.stringify({ prompt: "say hi" }),
      }),
    );
    const frames = await readAllSse(resp);
    const done = frames.find((f) => f.startsWith("event: done"));
    expect(done).toBeDefined();
    const payload = dataPayloads([done as string])[0];
    expect(typeof payload?.ms).toBe("number");
  });

  it("rejects missing prompt with 400", async () => {
    const resp = await POST(
      new Request("http://localhost/api/streaming", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(resp.status).toBe(400);
  });

  it("rejects invalid JSON body with 400", async () => {
    const resp = await POST(
      new Request("http://localhost/api/streaming", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(resp.status).toBe(400);
  });
});
