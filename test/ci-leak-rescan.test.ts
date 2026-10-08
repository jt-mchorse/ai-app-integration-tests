/**
 * The `no-leaked-secrets` CI job re-runs the recorder's scanner (#171).
 *
 * The README says "a CI job re-checks every committed cassette so a future
 * leak fails the build", and `docs/architecture.md` that the job "re-runs the
 * body scan". It ran two hand-written `grep -E` lines instead: 2 of the 7
 * `API_KEY_PATTERNS`, each still ending in the trailing `\b` #60 removed from
 * the scanner. Six of the seven rows below passed that job; the recorder
 * refuses all seven.
 *
 * Each row is a full cassette carrying one credential shape, written to a temp
 * `fixtures/` and fed to the script by spawning it — a unit test of
 * `assertNoLeakedSecrets` cannot show that CI calls it, which is the half that
 * was missing. The last block pins that the workflow job runs this script,
 * unguarded, on `fixtures`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "scan-committed-cassettes.ts");
const SCRIPT_REL = "scripts/scan-committed-cassettes.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function cassette(url: string, responseText: string): object {
  return {
    schema_version: "1",
    request_hash: "0".repeat(32),
    request: {
      method: "POST",
      url,
      headers: { "content-type": "application/json", "x-api-key": "[REDACTED]" },
      body: { model: "claude-haiku-4-5-20251001" },
    },
    response: { kind: "non_stream", status: 200, headers: {}, body: responseText },
    recorded_at: "2026-10-08T00:00:00.000Z",
  };
}

function fixturesWith(files: Record<string, object | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "aiapp-leak-rescan-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function scan(dir: string) {
  return spawnSync("npx", ["tsx", SCRIPT, dir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
}

const API = "https://api.anthropic.com/v1/messages";

// [label, cassette]. Every row but the first passed the old grep job.
const LEAKS: Array<[string, object]> = [
  ["a plain sk- key (the one shape the old job caught)", cassette(API, `sk-${"a".repeat(40)}`)],
  ["an sk- key ending in '-' (#60's trailing \\b)", cassette(API, `key sk-${"a".repeat(31)}-`)],
  ["a Bearer token ending in '==' padding", cassette(API, `Bearer ${"A".repeat(18)}==`)],
  ["a Google AIza key", cassette(API, `AIza${"B".repeat(35)}`)],
  ["HTTP Basic credentials", cassette(API, "Basic dXNlcjpwYXNzd29yZDEyMw==")],
  ["URL userinfo", cassette("https://user:hunter2@example.com/v1", "ok")],
  ["an ?api-key= query string", cassette(`${API}?api-key=${"0123456789abcdef".repeat(2)}`, "ok")],
];

describe("scripts/scan-committed-cassettes.ts", () => {
  it.each(LEAKS)("refuses %s with exit 1, naming the file", (_label, c) => {
    const dir = fixturesWith({ "leak.json": c });
    const r = scan(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("leak.json");
    expect(r.stderr).toContain("unredacted secret");
  });

  it("finds a leak in a nested directory among clean cassettes", () => {
    const dir = fixturesWith({
      "a.json": cassette(API, "4"),
      "sub/b.json": cassette(API, `AIza${"B".repeat(35)}`),
      "z.json": cassette(API, "20"),
    });
    const r = scan(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("b.json");
    expect(r.stderr).toContain("1 of 3");
  });

  it("passes clean cassettes, including prose that merely resembles a prefix", () => {
    // Anti-vacuous: a script that refused everything passes every row above.
    const dir = fixturesWith({
      "a.json": cassette(API, "the Basic plan includes a key insight"),
      "b.json": cassette(API, "20"),
    });
    const r = scan(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("in 2 cassette(s)");
  });

  it("passes the committed fixtures/", () => {
    const r = scan(join(REPO_ROOT, "fixtures"));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/in [1-9]\d* cassette\(s\)/);
  });

  it("fails closed on a file it cannot read as a cassette", () => {
    expect(scan(fixturesWith({ "bad.json": "{not json" })).status).toBe(1);
    expect(scan(fixturesWith({ "bad.json": "[1, 2]" })).status).toBe(1);
  });

  it("exits 2 for a directory that does not exist rather than scanning nothing", () => {
    expect(scan(join(REPO_ROOT, "no-such-fixtures-dir")).status).toBe(2);
  });
});

describe("the no-leaked-secrets workflow job", () => {
  type Step = { run?: string };
  const wf = yaml.load(
    readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8"),
  ) as { jobs: Record<string, { steps: Step[] }> };
  const runs = wf.jobs["no-leaked-secrets"].steps
    .map((s) => s.run ?? "")
    .filter((r) => r.length > 0);

  it("runs the recorder's scanner over fixtures, with nothing swallowing its exit code", () => {
    const scanLines = runs
      .flatMap((r) => r.split("\n"))
      .filter((line) => line.includes(SCRIPT_REL));
    expect(scanLines).toHaveLength(1);
    expect(scanLines[0]).toMatch(/\bnpx tsx scripts\/scan-committed-cassettes\.ts fixtures\s*$/);
    expect(scanLines[0]).not.toMatch(/\|\||;|&/);
  });

  it("installs dependencies before running it (tsx and the scanner's imports)", () => {
    const ci = runs.findIndex((r) => /\bnpm ci\b/.test(r));
    const scanIdx = runs.findIndex((r) => r.includes(SCRIPT_REL));
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(ci).toBeLessThan(scanIdx);
  });

  it("no longer carries a hand-written grep copy of the patterns", () => {
    expect(runs.join("\n")).not.toMatch(/\bgrep\b/);
  });
});
