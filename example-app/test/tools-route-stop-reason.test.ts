/**
 * /api/tools answers only when the model finished (#179).
 *
 * The two-turn loop never read `stop_reason`: a turn cut at `max_tokens` (256
 * here) returned its truncated text as `finalText`, a cut `tool_use` block ran
 * its tool on partial input, and a model still calling tools after the last
 * turn produced `{finalText: ""}` -- all with status 200.
 */
import { afterEach, describe, expect, it } from "vitest";

import { POST } from "../app/api/tools/route.js";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

const msg = (content: unknown[], stop_reason: string) => ({
  id: "msg",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5-20251001",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});
const CALC = { type: "tool_use", id: "toolu_1", name: "calculate", input: { expression: "17 * 23" } };
const TEXT = (t: string) => ({ type: "text", text: t });

let requests = 0;
function upstream(...bodies: unknown[]): void {
  requests = 0;
  globalThis.fetch = (async () => {
    const body = bodies[requests];
    requests += 1;
    if (!body) throw new Error("no more canned responses");
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function call(): Promise<{ status: number; body: Record<string, unknown> }> {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-not-real";
  const res = await POST(
    new Request("http://localhost/api/tools", { method: "POST", body: JSON.stringify({ query: "17 * 23?" }) }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("/api/tools stop_reason (#179)", () => {
  it("a final answer cut at max_tokens is a 502, not finalText", async () => {
    upstream(msg([CALC], "tool_use"), msg([TEXT("17 * 23 is")], "max_tokens"));
    const { status, body } = await call();
    expect(status).toBe(502);
    expect(String(body.error)).toContain("stop_reason=max_tokens");
    expect(body.finalText).toBeUndefined();
  });

  it("a tool_use block cut at max_tokens does not run its tool", async () => {
    upstream(msg([TEXT("Let me compute"), { ...CALC, input: { expression: "17 *" } }], "max_tokens"));
    const { status, body } = await call();
    expect(status).toBe(502);
    expect(body.toolCalls).toEqual([]);
    expect(requests).toBe(1);
  });

  it.each(["refusal", "pause_turn"])("stop_reason=%s is a 502 naming it", async (stop) => {
    upstream(msg([TEXT("…")], stop));
    const { status, body } = await call();
    expect(status).toBe(502);
    expect(String(body.error)).toContain(`stop_reason=${stop}`);
  });

  it("a model still calling tools after the last turn is a 502, not finalText ''", async () => {
    upstream(msg([CALC], "tool_use"), msg([{ ...CALC, id: "toolu_2" }], "tool_use"));
    const { status, body } = await call();
    expect(status).toBe(502);
    expect(String(body.error)).toContain("still calling tools");
    expect((body.toolCalls as unknown[]).length).toBe(2);
  });

  it.each(["end_turn", "stop_sequence"])("a finished answer (%s) is returned as before", async (stop) => {
    upstream(msg([CALC], "tool_use"), msg([TEXT("17 * 23 is 391.")], stop));
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.finalText).toBe("17 * 23 is 391.");
    expect((body.toolCalls as Array<{ result: unknown }>)[0]?.result).toBeDefined();
  });
});
