/**
 * The replay stub answers a non-streaming call with JSON (#209).
 *
 * The README says all three screens run under
 * `ANTHROPIC_TEST_MODE=replay npm run example:dev` without an API key. The
 * stub answered every request with its canned SSE stream, including the
 * non-streaming `messages.create` calls `/api/tools` and `/api/error` make. The
 * SDK read the event-stream text as the message, so `/tools` 502'd with
 * `stop_reason=undefined` on every query and `/error` -> upstream reported
 * "expected an upstream error", the branch for an upstream that did NOT fail.
 *
 * These drive the real route handlers through the installed stub, so the
 * routes see exactly what the dev server's routes see.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as errorPOST } from "../app/api/error/route.js";
import { POST as streamingPOST } from "../app/api/streaming/route.js";
import { POST as toolsPOST } from "../app/api/tools/route.js";
import { installPlaywrightStub } from "../instrumentation-stub.js";

const ORIGINAL_FETCH = globalThis.fetch;
let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  installPlaywrightStub();
});

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

function post(body: unknown): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function messagesRequest(body: Record<string, unknown>): Promise<Response> {
  return globalThis.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/tools under the stub", () => {
  it("runs calculate for the page's default query and returns its answer", async () => {
    const res = await toolsPOST(post({ query: "What's 17 * 23?" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      toolCalls: Array<{ name: string; input: unknown; result: unknown }>;
      finalText: string;
    };
    expect(json.toolCalls).toEqual([
      { name: "calculate", input: { expression: "17 * 23" }, result: { expression: "17 * 23", value: 391 } },
    ]);
    expect(json.finalText).toContain("391");
  });

  it("runs get_weather for a city query", async () => {
    const res = await toolsPOST(post({ query: "What's the weather in Paris?" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      toolCalls: Array<{ name: string; input: unknown }>;
      finalText: string;
    };
    expect(json.toolCalls.map((t) => [t.name, t.input])).toEqual([["get_weather", { city: "Paris" }]]);
    expect(json.finalText).toContain("sunny");
  });
});

describe("/api/error under the stub", () => {
  it("reports the unknown model as an upstream 404 not_found_error", async () => {
    const res = await errorPOST(post({ kind: "upstream", prompt: "synthetic" }));
    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("upstream");
    expect(json.message).not.toBe("expected an upstream error");
    expect(json.status).toBe(404);
    expect(json.type).toBe("NotFoundError");
    expect(json.api_error_type).toBe("not_found_error");
  });
});

describe("the stub's own answers", () => {
  it("answers a non-streaming call without tools with a JSON text message", async () => {
    const res = await messagesRequest({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.headers.get("content-type")).toBe("application/json");
    const json = (await res.json()) as { stop_reason: unknown; content: Array<{ type: string }> };
    expect(json.stop_reason).toBe("end_turn");
    expect(json.content.map((b) => b.type)).toEqual(["text"]);
  });

  it("still answers a stream: true call with the canned SSE stream", async () => {
    const res = await messagesRequest({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8,
      stream: true,
      messages: [{ role: "user", content: "short reply please" }],
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const text = await res.text();
    expect(text.startsWith("event: message_start\n")).toBe(true);
    expect(text).toContain('"text":"Hi."');
    expect(text.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });

  it("keeps /api/streaming on the SSE path end to end", async () => {
    const res = await streamingPOST(post({ prompt: "short reply please" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Hi.");
    expect(text).toContain("event: done");
  });
});
