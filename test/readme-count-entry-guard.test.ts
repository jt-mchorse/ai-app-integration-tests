/**
 * The README-count gate runs when invoked through a symlink or a spaced path (#169).
 *
 * `tools/check-readme-test-count.mjs` guarded `main()` with
 * `import.meta.url === \`file://${process.argv[1]}\``. `import.meta.url` is the
 * realpath, percent-encoded; `argv[1]` is the path as typed. Through a symlink
 * (macOS `/tmp`) or under a directory named with a space they never matched,
 * `main()` never ran, and the gate exited 0 without reading a report.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ROOT } from "../tools/check-readme-test-count.mjs";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "aiapp-entry-guard-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MISSING = join(scratch, "no-such-report.json");

function runChecker(scriptPath: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [scriptPath, MISSING], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A copy of the checker (and the README it reads) under `dir`. */
function copyCheckerInto(dir: string): string {
  mkdirSync(join(dir, "tools"), { recursive: true });
  copyFileSync(join(ROOT, "README.md"), join(dir, "README.md"));
  const script = join(dir, "tools", "check-readme-test-count.mjs");
  copyFileSync(join(ROOT, "tools", "check-readme-test-count.mjs"), script);
  return script;
}

describe("check-readme-test-count entry guard (#169)", () => {
  it("control: invoked by its real path, a missing report exits 2", () => {
    const r = runChecker(copyCheckerInto(join(scratch, "plain")));
    expect(r.out).toContain("cannot read the vitest report");
    expect(r.status).toBe(2);
  });

  it("invoked through a symlinked directory, the gate still runs and exits 2", () => {
    const real = join(scratch, "real");
    copyCheckerInto(real);
    const link = join(scratch, "link");
    symlinkSync(real, link, "dir");
    const r = runChecker(join(link, "tools", "check-readme-test-count.mjs"));
    expect(r.out).toContain("cannot read the vitest report");
    expect(r.status).toBe(2);
  });

  it("invoked under a directory whose name has a space, the gate still runs and exits 2", () => {
    const r = runChecker(copyCheckerInto(join(scratch, "has a space")));
    expect(r.out).toContain("cannot read the vitest report");
    expect(r.status).toBe(2);
  });
});
