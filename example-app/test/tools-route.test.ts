/**
 * Test the /api/tools route handler in-process.
 *
 * Drives a two-turn loop:
 *   turn 1 — model returns a `tool_use` block (calculate)
 *   turn 2 — model returns a final text answer
 *
 * Each `fetch` call returns one canned response; ordering matters.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../app/api/tools/route.js";

const ORIGINAL_FETCH = globalThis.fetch;

interface CannedResponse {
  status: number;
  body: unknown;
}

function jsonResponse(c: CannedResponse): Response {
  return new Response(JSON.stringify(c.body), {
    status: c.status,
    headers: { "content-type": "application/json" },
  });
}

function fakeAnthropicSeq(responses: CannedResponse[]): typeof fetch {
  let i = 0;
  return (async () => {
    const next = responses[i];
    i += 1;
    if (!next) throw new Error("fakeAnthropicSeq: exhausted; no more canned responses");
    return jsonResponse(next);
  }) as typeof fetch;
}

const TOOL_USE_CALCULATE = {
  id: "msg_t1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5-20251001",
  content: [
    {
      type: "tool_use",
      id: "toolu_calc_0",
      name: "calculate",
      input: { expression: "17 * 23" },
    },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 80, output_tokens: 20 },
};

const FINAL_TEXT = {
  id: "msg_t2",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5-20251001",
  content: [{ type: "text", text: "17 * 23 is 391." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 12 },
};

const TOOL_USE_WEATHER = {
  ...TOOL_USE_CALCULATE,
  content: [
    {
      type: "tool_use",
      id: "toolu_w_0",
      name: "get_weather",
      input: { city: "Austin" },
    },
  ],
};

describe("/api/tools", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("routes a math question through the calculate tool and returns the final answer", async () => {
    globalThis.fetch = fakeAnthropicSeq([
      { status: 200, body: TOOL_USE_CALCULATE },
      { status: 200, body: FINAL_TEXT },
    ]);
    const resp = await POST(
      new Request("http://localhost/api/tools", {
        method: "POST",
        body: JSON.stringify({ query: "What's 17 * 23?" }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      toolCalls: Array<{ name: string; input: unknown; result: unknown }>;
      finalText: string;
    };
    expect(body.toolCalls).toHaveLength(1);
    expect(body.toolCalls[0]?.name).toBe("calculate");
    expect(body.toolCalls[0]?.result).toEqual({ expression: "17 * 23", value: 391 });
    expect(body.finalText).toMatch(/391/);
  });

  it("routes a weather question through the get_weather tool", async () => {
    globalThis.fetch = fakeAnthropicSeq([
      { status: 200, body: TOOL_USE_WEATHER },
      { status: 200, body: FINAL_TEXT },
    ]);
    const resp = await POST(
      new Request("http://localhost/api/tools", {
        method: "POST",
        body: JSON.stringify({ query: "Austin weather?" }),
      }),
    );
    const body = (await resp.json()) as {
      toolCalls: Array<{ name: string; input: unknown; result: unknown }>;
      finalText: string;
    };
    expect(body.toolCalls).toHaveLength(1);
    expect(body.toolCalls[0]?.name).toBe("get_weather");
    expect(body.toolCalls[0]?.result).toMatchObject({
      city: "Austin",
      condition: "sunny",
      temperature_c: 22,
    });
  });

  it("rejects expressions outside the deterministic character set", async () => {
    // Calculate tool blocks anything with letters; the route returns the
    // tool's structured error in the toolCalls list rather than crashing.
    globalThis.fetch = fakeAnthropicSeq([
      {
        status: 200,
        body: {
          ...TOOL_USE_CALCULATE,
          content: [
            {
              type: "tool_use",
              id: "toolu_bad_0",
              name: "calculate",
              input: { expression: "process.exit(1)" },
            },
          ],
        },
      },
      { status: 200, body: FINAL_TEXT },
    ]);
    const resp = await POST(
      new Request("http://localhost/api/tools", {
        method: "POST",
        body: JSON.stringify({ query: "do something dangerous" }),
      }),
    );
    const body = (await resp.json()) as {
      toolCalls: Array<{ name: string; input: unknown; result: { error?: string } }>;
    };
    expect(body.toolCalls[0]?.result.error).toMatch(/unsupported characters/);
  });

  it("rejects missing query with 400", async () => {
    const resp = await POST(
      new Request("http://localhost/api/tools", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(resp.status).toBe(400);
  });

  it("rejects invalid JSON body with 400", async () => {
    const resp = await POST(
      new Request("http://localhost/api/tools", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(resp.status).toBe(400);
  });
});

beforeEach(() => {
  // Each test reassigns; reset between to be safe.
  globalThis.fetch = ORIGINAL_FETCH;
});
