/**
 * The committed-cassette scanner's report survives a slow pipe reader (#269).
 *
 * The scanner printed one `::error` line per refused file and a summary, then
 * called `process.exit(1)`. A write to a pipe is asynchronous on macOS: once
 * the socket buffer is full the rest of the report waits in the stream's queue,
 * and `process.exit()` drops it. With a reader that did not read until the
 * child exited, origin/main returned 49 of 1000 `::error` lines (24,785 bytes)
 * on Node 20.9 and 259 of 1000 (131,022 bytes) on Node 25.5, with no summary
 * and the exit code still 1. That is the flake in
 * `leak-scanner-camel-case-prefix.test.ts`'s rescan arm under load.
 *
 * Linux pipes are written synchronously, so on Ubuntu CI the overflow arm is a
 * control. The last block pins the shape on every platform: no script this
 * repo spawns ends with `process.exit(`.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "scan-committed-cassettes.ts");

// Built from parts so this file is not a leak.
const FAKE_KEY = ["sk", "ant", "api03", "z".repeat(40)].join("-");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function cassette(apiKey: string): object {
  return {
    schema_version: "1",
    request_hash: "0".repeat(32),
    request: {
      method: "POST",
      url: "https://api.example.com/v1/x",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: { model: "claude-haiku-4-5-20251001" },
    },
    response: { kind: "non_streaming", status: 200, headers: {}, body: '{"ok":true}' },
    recorded_at: "2026-10-30T00:00:00.000Z",
  };
}

/** A temp dir holding `leaks` refused cassettes and `clean` clean ones. */
function fixtures(leaks: number, clean: number): { dir: string; leakNames: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "aiit-pipe-drain-"));
  tempDirs.push(dir);
  // A long name makes each `::error` line about 500 bytes, so 1000 of them
  // (~500 KB) are far past the ~24 KB (Node 20) and ~131 KB (Node 25) that
  // reached a paused reader on macOS before the drop.
  const pad = "p".repeat(160);
  const leakNames: string[] = [];
  for (let i = 0; i < leaks; i++) {
    const name = `leak-${String(i).padStart(3, "0")}-${pad}.json`;
    leakNames.push(name);
    writeFileSync(join(dir, name), JSON.stringify(cassette(FAKE_KEY)));
  }
  for (let i = 0; i < clean; i++) {
    writeFileSync(join(dir, `clean-${i}.json`), JSON.stringify(cassette("[REDACTED]")));
  }
  return { dir, leakNames };
}

// The longest the reader stops after the first chunk of stderr. It resumes
// sooner when the child exits, which is when the unfixed script had already
// dropped its queue. A fixed script waits for the reader, so a passing run
// costs this much. At 1 s the unfixed script still finished its 1000-file scan
// inside the stall only 4 runs of 6, cold runs being slower.
const STALL_MS = 5_000;

/**
 * Run the scanner with a reader that stalls: it takes the first chunk of
 * stderr, then reads nothing until the child exits or `STALL_MS` passes.
 * Everything past the pipe buffer is still in the child's queue when the
 * script reaches its last line.
 *
 * Not "read nothing until the child exits": a script that drains before it
 * exits (the fix) would then block on the full pipe forever.
 */
function runWithStalledReader(arg: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", SCRIPT, arg], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let status: number | null = null;
    let stalled = false;
    child.on("error", reject);
    let timer: NodeJS.Timeout | undefined;
    child.on("exit", (code) => {
      status = code;
      clearTimeout(timer);
      child.stderr.resume();
    });
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => {
      err.push(b);
      if (stalled) return;
      stalled = true;
      child.stderr.pause();
      timer = setTimeout(() => child.stderr.resume(), STALL_MS);
    });
    child.on("close", () =>
      resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
  });
}

describe("the scanner's report is complete when the reader is slower than the scan (#269)", () => {
  it("every refused file, the summary and exit 1 arrive past a full pipe buffer", async () => {
    const { dir, leakNames } = fixtures(1000, 3);
    const r = await runWithStalledReader(dir);
    expect(r.status).toBe(1);
    const errorLines = r.stderr.split("\n").filter((l) => l.startsWith("::error file="));
    expect(errorLines).toHaveLength(1000);
    for (const name of leakNames) expect(r.stderr).toContain(name);
    expect(r.stderr).toContain(`1000 of 1003 cassette(s) under ${dir}/ refused.`);
    expect(r.stdout).toBe("");
  }, 120_000);

  it("control: a directory that does not exist is exit 2 with its message", async () => {
    const missing = join(tmpdir(), "aiit-pipe-drain-does-not-exist");
    const r = await runWithStalledReader(missing);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${JSON.stringify(missing)} is not a directory`);
    // The success line must not follow the exit-2 message now that nothing exits early.
    expect(r.stdout).toBe("");
  }, 120_000);

  it("control: a clean directory is exit 0 with the success line and nothing on stderr", async () => {
    const { dir } = fixtures(0, 3);
    const r = await runWithStalledReader(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`no leaked secrets found in 3 cassette(s) under ${dir}/\n`);
    expect(r.stderr).toBe("");
  }, 120_000);
});

describe("no spawned script ends with process.exit() after a print (#269)", () => {
  // The sites that printed and then exited: the scanner, the missing-cassette
  // demo (`test/missing-cassette-demo-env-guard.test.ts` spawns it), and the
  // README count checker CI runs. Comments are stripped so the explanations
  // that name `process.exit()` do not count.
  it.each(["scripts/scan-committed-cassettes.ts", "scripts/missing_cassette_demo.ts", "tools/check-readme-test-count.mjs"])(
    "%s",
    (rel) => {
      const code = readFileSync(join(REPO_ROOT, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/process\.exit\s*\(/);
    },
  );
});
