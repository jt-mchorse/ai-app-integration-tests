// The real Anthropic SDK's connection failures are retried by the default
// classifier (#163). Before the fix both arms made exactly ONE call: the SDK's
// APIConnectionError / APIConnectionTimeoutError carry the network failure on
// `.cause` (or nowhere), and the classifier read only the outer error.
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { RetryBudgetExhaustedError, withRetryBudget } from "../../src/support/retry-budget";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function refusedBaseUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", () => done()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((done) => s.close(() => done()));
  return `http://127.0.0.1:${port}`;
}

async function callsUnderBudget(baseURL: string, timeout?: number): Promise<{ calls: number; err: unknown }> {
  const client = new Anthropic({ apiKey: "sk-test-not-real", baseURL, maxRetries: 0, ...(timeout ? { timeout } : {}) });
  let calls = 0;
  const err = await withRetryBudget(
    () => {
      calls++;
      return client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "x" }],
      });
    },
    { maxAttempts: 3, backoffMs: 1, sleep: async () => {} },
  ).catch((e: unknown) => e);
  return { calls, err };
}

describe("withRetryBudget + the real Anthropic SDK (#163)", () => {
  it("a refused connection is retried to the budget", async () => {
    const { calls, err } = await callsUnderBudget(await refusedBaseUrl());
    expect(calls).toBe(3);
    expect(err).toBeInstanceOf(RetryBudgetExhaustedError);
  });

  it("a server that accepts and never answers is retried to the budget", async () => {
    const held: ServerResponse[] = [];
    const base = await listen((_req, res) => {
      held.push(res);
    });
    const { calls, err } = await callsUnderBudget(base, 200);
    for (const res of held) res.destroy();
    expect(calls).toBe(3);
    expect(err).toBeInstanceOf(RetryBudgetExhaustedError);
  });

  it("a 400 from the API is not retried (control)", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }));
    });
    const { calls } = await callsUnderBudget(base);
    expect(calls).toBe(1);
  });
});
