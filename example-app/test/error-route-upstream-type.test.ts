/**
 * `/api/error`'s upstream case names the SDK error and the API's type (#187).
 *
 * It reported `type: e.name ?? "Error"`, and every @anthropic-ai/sdk 0.96 API
 * error has `.name === "Error"`: the class is on `constructor.name`, and the
 * API's own type is in the response envelope. Every upstream failure read
 * `"type": "Error"`.
 */
import { afterEach, describe, expect, it } from "vitest";

import { POST } from "../app/api/error/route.js";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function upstreamFails(status: number, apiType: string): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ type: "error", error: { type: apiType, message: "x" } }), {
      status,
      // The SDK honours this, so the retried statuses do not wait out a backoff.
      headers: { "content-type": "application/json", "retry-after-ms": "0" },
    })) as typeof fetch;
}

async function upstream(): Promise<Record<string, unknown>> {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-not-real";
  const res = await POST(
    new Request("http://localhost/api/error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "upstream" }),
    }),
  );
  expect(res.status).toBe(502);
  return (await res.json()) as Record<string, unknown>;
}

describe("/api/error upstream type (#187)", () => {
  it.each([
    [404, "not_found_error", "NotFoundError"],
    [429, "rate_limit_error", "RateLimitError"],
    [500, "api_error", "InternalServerError"],
  ])("%i names %s and the SDK class", async (status, apiType, sdkClass) => {
    upstreamFails(status, apiType);
    const body = await upstream();
    expect(body.error).toBe("upstream");
    expect(body.status).toBe(status);
    expect(body.type).toBe(sdkClass);
    expect(body.api_error_type).toBe(apiType);
  });
});
