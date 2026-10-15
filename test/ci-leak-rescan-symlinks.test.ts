/**
 * The committed-cassette rescan follows symlinks (#203).
 *
 * `scan-committed-cassettes` walked the directory with `Dirent.isFile()` and
 * `isDirectory()`, which describe a symlink itself, so both are false for one.
 * A symlinked cassette, a symlinked directory of cassettes and a dangling
 * `.json` link were all skipped, and the job reported "0 cassette(s)" and
 * exited 0. Replay does not skip them: `CassetteStore.read` follows the link,
 * and #181 made `write` write through it. The last test pins that replay reads
 * the very file the gate now refuses, so the two cannot drift apart again.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { CassetteStore } from "../src/io.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "scan-committed-cassettes.ts");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const LEAKY = "0".repeat(32);
const CLEAN = "1".repeat(32);

function cassette(hash: string, note: string): string {
  return JSON.stringify({
    schema_version: "1",
    request_hash: hash,
    request: { method: "POST", url: "https://api.example.com/v1", headers: {}, body: { note } },
    response: { kind: "non_streaming", status: 200, headers: {}, body: "ok" },
    recorded_at: "2026-10-14T00:00:00.000Z",
  });
}

const LEAK_TEXT = `sk-ant-${"A".repeat(40)}`;

/** A temp root holding `fixtures/` (scanned) and `shared/` (a link target). */
function layout(): { root: string; fixtures: string; shared: string } {
  const root = mkdtempSync(join(tmpdir(), "aiapp-rescan-links-"));
  tempDirs.push(root);
  const fixtures = join(root, "fixtures");
  const shared = join(root, "shared");
  mkdirSync(fixtures);
  mkdirSync(shared);
  return { root, fixtures, shared };
}

function scan(dir: string) {
  return spawnSync("npx", ["tsx", SCRIPT, dir], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
}

describe("scan-committed-cassettes follows symlinks (#203)", () => {
  it("refuses a leaky cassette that is a symlink to a file outside the directory", () => {
    const { fixtures, shared } = layout();
    writeFileSync(join(shared, "leaky.json"), cassette(LEAKY, LEAK_TEXT));
    symlinkSync(join(shared, "leaky.json"), join(fixtures, `${LEAKY}.json`));
    const r = scan(fixtures);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${LEAKY}.json`);
    expect(r.stderr).toContain("unredacted secret");
  });

  it("walks a symlinked directory of cassettes", () => {
    const { fixtures, shared } = layout();
    writeFileSync(join(shared, `${LEAKY}.json`), cassette(LEAKY, LEAK_TEXT));
    symlinkSync(shared, join(fixtures, "common"));
    const r = scan(fixtures);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(join("common", `${LEAKY}.json`));
  });

  it("fails closed on a dangling .json link, naming it unreadable", () => {
    const { root, fixtures } = layout();
    symlinkSync(join(root, "nowhere.json"), join(fixtures, "dangling.json"));
    const r = scan(fixtures);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dangling.json");
    expect(r.stderr).toContain("not readable");
  });

  it("terminates on a directory link loop and still scans each cassette", () => {
    const { fixtures } = layout();
    writeFileSync(join(fixtures, `${CLEAN}.json`), cassette(CLEAN, "fine"));
    symlinkSync(fixtures, join(fixtures, "loop"));
    const r = scan(fixtures);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("in 1 cassette(s)");
  });

  it("passes and counts a clean symlinked cassette", () => {
    // Anti-vacuous: a walk that refused every link would pass the rows above.
    const { fixtures, shared } = layout();
    writeFileSync(join(shared, "clean.json"), cassette(CLEAN, "fine"));
    symlinkSync(join(shared, "clean.json"), join(fixtures, `${CLEAN}.json`));
    const r = scan(fixtures);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("in 1 cassette(s)");
  });

  it("replay reads the symlinked cassette the gate refuses", async () => {
    const { fixtures, shared } = layout();
    writeFileSync(join(shared, "leaky.json"), cassette(LEAKY, LEAK_TEXT));
    symlinkSync(join(shared, "leaky.json"), join(fixtures, `${LEAKY}.json`));
    const read = await new CassetteStore({ dir: fixtures }).read(LEAKY);
    expect(read?.request.body).toEqual({ note: LEAK_TEXT });
    expect(scan(fixtures).status).toBe(1);
  });
});
