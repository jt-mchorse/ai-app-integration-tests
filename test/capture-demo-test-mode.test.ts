/**
 * The capture is hermetic whatever ANTHROPIC_TEST_MODE the shell exports (#153).
 *
 * Surface 1 ran `test/demo.test.ts`, whose `installFromEnv()` reads
 * ANTHROPIC_TEST_MODE from the operator's shell -- and that file's own header
 * tells them to export it to re-record. Inherited "record" overwrote the
 * committed cassette the demo replays (with a 401, under a fake key); "live"
 * called api.anthropic.com. These arms run the real script with each mode and
 * a fetch trap preloaded through NODE_OPTIONS, so nothing leaves the machine:
 * the trap logs any call to api.anthropic.com and answers 401, which is what
 * the recorder would have written.
 *
 * The committed cassette is restored byte-for-byte after every arm, so a red
 * run (the unfixed script) does not leave the tree dirty.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "capture_demo.sh");
const CASSETTE = resolve(REPO_ROOT, "fixtures", "a154fc0b65d0d40c779b713bd7b65138.json");

const scratch = mkdtempSync(join(tmpdir(), "aai-capture-mode-"));
const TRAP = join(scratch, "fetch-trap.cjs");
writeFileSync(
  TRAP,
  `const orig = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/api\\.anthropic\\.com/.test(url)) {
    require("fs").appendFileSync(process.env.FETCH_TRAP_LOG, url + "\\n");
    return new Response('{"type":"error","error":{"type":"authentication_error"}}', {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return orig.call(this, input, init);
};
`,
);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("scripts/capture_demo.sh under an exported ANTHROPIC_TEST_MODE (#153)", () => {
  it.each(["record", "live"])("%s: no call reaches the API and the committed cassette is untouched", (mode) => {
    const before = readFileSync(CASSETTE);
    const log = join(scratch, `${mode}.log`);
    try {
      const r = spawnSync("bash", [SCRIPT], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CAPTURE_PACE_SECONDS: "0",
          CAPTURE_SKIP_E2E: "1",
          ANTHROPIC_TEST_MODE: mode,
          ANTHROPIC_API_KEY: "sk-ant-fake-not-a-key",
          NODE_OPTIONS: `--require ${TRAP}`,
          FETCH_TRAP_LOG: log,
        },
        encoding: "utf8",
        timeout: 90_000,
      });
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      expect(calls, "outbound calls to api.anthropic.com").toBe("");
      expect(readFileSync(CASSETTE).equals(before), "the committed cassette was rewritten").toBe(true);
      expect(r.status, r.stdout.slice(-800) + r.stderr.slice(-800)).toBe(0);
    } finally {
      writeFileSync(CASSETTE, before);
    }
  }, 100_000);
});

describe("surface 3 refuses a server it did not start (#153)", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const config = readFileSync(resolve(REPO_ROOT, "example-app", "playwright.config.ts"), "utf8");

  it("checks the port Playwright's config reuses, before building and running e2e", () => {
    const port = config.match(/baseURL:\s*"http:\/\/127\.0\.0\.1:(\d+)"/)?.[1];
    expect(port).toBeDefined();
    expect(config).toContain("reuseExistingServer: !process.env.CI");
    const check = script.indexOf(`(echo > /dev/tcp/127.0.0.1/${port})`);
    expect(check).toBeGreaterThan(-1);
    const build = script.indexOf("\n  npm run example:build\n");
    const e2e = script.indexOf("\n  npm run test:e2e --prefix example-app\n");
    expect(build).toBeGreaterThan(-1);
    expect(e2e).toBeGreaterThan(-1);
    expect(check).toBeLessThan(build);
    expect(check).toBeLessThan(e2e);
  });
});
