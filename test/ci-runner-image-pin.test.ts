/**
 * The `playwright` job is pinned to a runner image Playwright supports (#227).
 *
 * `ubuntu-latest` began resolving to ubuntu-26.04 on 2026-10-19, and the
 * pinned Playwright (1.60.0) refuses that image while installing Chromium, so
 * every PR went red before a test ran and main was one push from red. The pin
 * is only right while the installed Playwright refuses the newer image, so
 * the test ties the pin to the version that justifies it: bumping Playwright
 * fails this test until someone decides whether the pin can go.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const workflow = yaml.load(
  readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8"),
) as { jobs: Record<string, { "runs-on": string }> };

function installedPlaywright(): string {
  const lock = JSON.parse(
    readFileSync(join(REPO_ROOT, "example-app", "package-lock.json"), "utf8"),
  ) as { packages: Record<string, { version?: string }> };
  const v = lock.packages["node_modules/@playwright/test"]?.version;
  if (!v) throw new Error("example-app lockfile has no @playwright/test");
  return v;
}

describe("playwright CI runner image (#227)", () => {
  it("runs the playwright job on ubuntu-24.04, not ubuntu-latest", () => {
    expect(workflow.jobs.playwright["runs-on"]).toBe("ubuntu-24.04");
  });

  it("keeps the pin tied to the Playwright version that refuses ubuntu-26.04", () => {
    // If this fails after a Playwright bump, check whether the new version
    // installs on ubuntu-latest; if it does, drop the pin and this test.
    expect(installedPlaywright()).toBe("1.60.0");
  });

  it("leaves every other job on ubuntu-latest (control)", () => {
    const others = Object.entries(workflow.jobs).filter(([name]) => name !== "playwright");
    expect(others.length).toBeGreaterThan(0);
    for (const [, job] of others) expect(job["runs-on"]).toBe("ubuntu-latest");
  });
});
