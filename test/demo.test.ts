/**
 * Demo test: shows the install-from-env / replay flow against a committed
 * fixture. This test runs in default replay mode in CI (no API key needed)
 * and exercises a real Anthropic-shaped request/response round-trip.
 *
 * To re-record: `ANTHROPIC_TEST_MODE=record ANTHROPIC_API_KEY=... npm test -- demo`
 * To run live: `ANTHROPIC_TEST_MODE=live ANTHROPIC_API_KEY=... npm test -- demo`
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installFromEnv, uninstall } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

describe("demo: replay an Anthropic /v1/messages cassette", () => {
  beforeAll(() => {
    installFromEnv({ fixturesDir: FIXTURES_DIR });
  });
  afterAll(() => {
    uninstall();
  });

  it("returns the recorded JSON response shape", async () => {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-test-key-do-not-use-1234567890abcdef",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: "What's the integer answer to 7+13? Reply with just the number.",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
    };
    expect(body.stop_reason).toBeDefined();
    const text = body.content.map((c) => c.text).join("");
    expect(text).toMatch(/20/);
  });
});
