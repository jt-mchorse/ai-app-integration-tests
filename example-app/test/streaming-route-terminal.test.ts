/**
 * /api/streaming ends in `event: done` only when the upstream finished (#177).
 *
 * The route forwarded `text_delta`s and then sent `event: done` unconditionally
 * -- the frame its docstring calls the terminal frame -- so an answer cut at
 * `max_tokens` (256 here, with any prompt the caller sends) or an upstream body
 * that ended mid-answer was reported as a finished stream. Same class as
 * nextjs-streaming-ai-patterns#167.
 */
import { afterEach, describe, expect, it } from "vitest";

import { POST } from "../app/api/streaming/route.js";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const START = [
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
  sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The answer is" } }),
];
const BLOCK_STOP = sse("content_block_stop", { type: "content_block_stop", index: 0 });
const delta = (stop: string) =>
  sse("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } });
const MESSAGE_STOP = sse("message_stop", { type: "message_stop" });

async function stream(frames: string[]): Promise<string> {
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const f of frames) c.enqueue(new TextEncoder().encode(f));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-not-real";
  const res = await POST(
    new Request("http://localhost/api/streaming", { method: "POST", body: JSON.stringify({ prompt: "q" }) }),
  );
  return res.text();
}

const last = (body: string) => body.trim().split("\n\n").at(-1) ?? "";

describe("/api/streaming terminal frame (#177)", () => {
  it.each(["max_tokens", "refusal", "pause_turn"])("stop_reason=%s ends in event: error naming it", async (stop) => {
    const body = await stream([...START, BLOCK_STOP, delta(stop), MESSAGE_STOP]);
    expect(body).not.toContain("event: done");
    expect(last(body)).toMatch(/^event: error\ndata: /);
    expect(last(body)).toContain(`stop_reason=${stop}`);
  });

  it.each([
    ["after a delta", [...START]],
    ["after message_delta, before message_stop", [...START, BLOCK_STOP, delta("end_turn")]],
  ])("an upstream that ends %s ends in event: error", async (_label, frames) => {
    const body = await stream(frames);
    expect(body).not.toContain("event: done");
    expect(last(body)).toContain("ended before message_stop");
  });

  it("the text that arrived is still forwarded first", async () => {
    const body = await stream([...START, BLOCK_STOP, delta("max_tokens"), MESSAGE_STOP]);
    expect(body.startsWith('data: {"text":"The answer is"}')).toBe(true);
  });

  it.each(["end_turn", "stop_sequence"])("stop_reason=%s with message_stop ends in event: done", async (stop) => {
    const body = await stream([...START, BLOCK_STOP, delta(stop), MESSAGE_STOP]);
    expect(last(body)).toMatch(/^event: done\ndata: \{"ms":\d+\}$/);
  });
});
