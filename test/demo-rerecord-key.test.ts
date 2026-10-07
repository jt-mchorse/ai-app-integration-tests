/**
 * The documented re-record sends the operator's key, not the test's fake (#161).
 *
 * `test/demo.test.ts` hardcoded `x-api-key`, so
 * `ANTHROPIC_TEST_MODE=record ANTHROPIC_API_KEY=sk-... npm test -- demo` sent
 * the fake key, got a 401, and the recorder wrote it over the committed
 * cassette (the request hash excludes headers, so it is the same file). This
 * runs the demo in record mode under a fetch trap -- nothing leaves the
 * machine -- and reads the key the trap received. The cassette is restored
 * byte for byte whatever happens.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const CASSETTE = path.join(ROOT, "fixtures", "a154fc0b65d0d40c779b713bd7b65138.json");
const ENV_KEY = ["sk", "ant", "from-the-environment", "y".repeat(32)].join("-");

const scratch = mkdtempSync(path.join(os.tmpdir(), "aiit-rerecord-"));
const TRAP = path.join(scratch, "trap.cjs");
const LOG = path.join(scratch, "keys.log");
writeFileSync(
  TRAP,
  `globalThis.fetch = async function (input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/api\\.anthropic\\.com/.test(url)) throw new Error("trap: unexpected " + url);
  const key = new Headers(init && init.headers).get("x-api-key");
  require("fs").appendFileSync(process.env.REREC_LOG, String(key) + "\\n");
  return new Response(JSON.stringify({
    id: "msg_trap", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: "20" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { "content-type": "application/json" } });
};
`,
);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("re-recording the demo cassette (#161)", () => {
  it("sends the ANTHROPIC_API_KEY from the environment", () => {
    const before = readFileSync(CASSETTE);
    try {
      spawnSync("npx", ["vitest", "run", "test/demo.test.ts"], {
        cwd: ROOT,
        env: {
          ...process.env,
          ANTHROPIC_TEST_MODE: "record",
          ANTHROPIC_API_KEY: ENV_KEY,
          NODE_OPTIONS: `--require ${TRAP}`,
          REREC_LOG: LOG,
        },
        encoding: "utf8",
        timeout: 120_000,
      });
      const sent = readFileSync(LOG, "utf8").trim().split("\n");
      expect(sent.length).toBeGreaterThan(0);
      expect(new Set(sent)).toEqual(new Set([ENV_KEY]));
    } finally {
      writeFileSync(CASSETTE, before);
    }
  }, 150_000);
});
