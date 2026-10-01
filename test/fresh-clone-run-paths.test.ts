/**
 * The documented run paths work on a fresh clone (#131).
 *
 * Three were broken in a fresh-clone audit on macOS:
 *   1. README's local e2e run: `test:e2e`'s webServer is `next start`, which
 *      needs a production build the README never asked for.
 *   2. `scripts/capture_demo.sh` surface 3 looked for chromium only at the
 *      Linux cache path, so on a Mac it always skipped -- and it never built.
 *   3. `npm run example:dev` with no key streams 401s on every screen, because
 *      the app deliberately defaults to `live` (#101); the README never said
 *      how to run it key-less.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const README = readFileSync(resolve(ROOT, "README.md"), "utf-8");
const SCRIPT = readFileSync(resolve(ROOT, "scripts", "capture_demo.sh"), "utf-8");
const PW_CONFIG = readFileSync(resolve(ROOT, "example-app", "playwright.config.ts"), "utf-8");

const firstIndex = (text: string, needle: RegExp): number => text.search(needle);

describe("fresh-clone run paths (#131)", () => {
  it("the premise: Playwright's webServer serves a production build", () => {
    // If this ever becomes `next dev` or builds itself, the build steps below
    // are redundant rather than wrong -- this arm says which world we are in.
    expect(PW_CONFIG).toMatch(/next\/dist\/bin\/next start/);
  });

  it("the README builds before every documented local e2e run", () => {
    const blocks = [...README.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
    const e2e = blocks.filter((b) => b.includes("test:e2e"));
    expect(e2e.length).toBeGreaterThan(0);
    for (const block of e2e) {
      const build = firstIndex(block, /npm run (example:build|build --prefix example-app)/);
      expect(build, block).toBeGreaterThan(-1);
      expect(build).toBeLessThan(firstIndex(block, /test:e2e/));
    }
  });

  it("capture_demo.sh builds before it runs the e2e suite", () => {
    const run = SCRIPT.lastIndexOf("npm run test:e2e --prefix example-app\n");
    const build = SCRIPT.lastIndexOf("npm run example:build\n");
    expect(run).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(run);
  });

  it("capture_demo.sh looks where Playwright installs on each OS", () => {
    for (const dir of [
      "$PLAYWRIGHT_BROWSERS_PATH",
      "$HOME/Library/Caches/ms-playwright",
      "$HOME/.cache/ms-playwright",
    ]) {
      expect(SCRIPT, dir).toContain(dir);
    }
  });

  it("the README says how to run the example app without a key", () => {
    expect(README).toContain("ANTHROPIC_TEST_MODE=replay npm run example:dev");
  });
});
