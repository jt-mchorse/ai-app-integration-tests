/**
 * capture_demo.sh installs example-app's dependencies before building it (#149).
 *
 * Surface 3's only gate was `chromium_installed()`, which also accepts the
 * GLOBAL Playwright cache. On a fresh clone of a machine that had Chromium from
 * another project, the script went straight to `npm run example:build` with
 * `example-app/node_modules` never installed: `next: command not found`, exit
 * 127. The real script runs here in a temp tree with stub `npm`/`npx` on PATH
 * (they log their arguments and succeed) and a fake Chromium cache, so the
 * branch is exercised without a browser or a network.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "capture_demo.sh");

function run(opts: { exampleDeps: boolean; chromium: boolean }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiit-capture-"));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(SCRIPT, path.join(root, "scripts", "capture_demo.sh"));
  mkdirSync(path.join(root, "example-app"));
  if (opts.exampleDeps) mkdirSync(path.join(root, "example-app", "node_modules"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const log = path.join(root, "calls.log");
  for (const tool of ["npm", "npx"]) {
    const stub = path.join(bin, tool);
    writeFileSync(stub, `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 0\n`);
    chmodSync(stub, 0o755);
  }
  const browsers = path.join(root, "browsers");
  mkdirSync(browsers);
  if (opts.chromium) mkdirSync(path.join(browsers, "chromium-1"));
  const home = path.join(root, "home"); // no global cache under this HOME
  mkdirSync(home);
  const r = spawnSync("bash", [path.join(root, "scripts", "capture_demo.sh")], {
    cwd: root,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      PLAYWRIGHT_BROWSERS_PATH: browsers,
      CAPTURE_PACE_SECONDS: "0",
    },
    encoding: "utf8",
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {
    calls = [];
  }
  return { status: r.status, stdout: r.stdout, calls };
}

describe("capture_demo.sh surface 3 (#149)", () => {
  it("installs example-app's dependencies, then builds, then runs e2e", () => {
    const r = run({ exampleDeps: false, chromium: true });
    expect(r.status).toBe(0);
    const surface3 = r.calls.filter((c) => c.startsWith("npm "));
    expect(surface3).toEqual([
      "npm run example:install",
      "npm run example:build",
      "npm run test:e2e --prefix example-app",
    ]);
  });

  it("does not reinstall when example-app's dependencies are present", () => {
    const r = run({ exampleDeps: true, chromium: true });
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain("npm run example:install");
    expect(r.calls).toContain("npm run example:build");
  });

  it("the skip hint includes the install a fresh clone needs", () => {
    const r = run({ exampleDeps: false, chromium: false });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "install once with: npm run example:install && npx --prefix example-app playwright install chromium",
    );
    expect(r.calls.some((c) => c.startsWith("npm "))).toBe(false);
  });
});
