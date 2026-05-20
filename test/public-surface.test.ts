/**
 * Public-surface tests for `src/index.ts`.
 *
 * The package's public surface re-exports ~25 names from five
 * submodules (`cassette`, `io`, `fetch-recorder`, `install`,
 * `support/index`). Every other test in this suite imports submodules
 * directly (`from "../src/cassette.js"`), so silent renames or
 * accidental drops in `src/index.ts` don't fail any test — but they
 * break the README's two quoted `import { ... } from
 * "ai-app-integration-tests"` snippets and the `package.json#exports`
 * contract for downstream consumers.
 *
 * Four axes, adapted from the agent-orchestration-platform TS
 * template (`agent-orchestration-platform#19`). This repo is
 * shape-equivalent (library with `src/index.ts` aggregator and a
 * dist build target), so the template is largely copy-paste — the
 * only swap is `package.json#exports."."` instead of
 * `package.json#bin` as the dist source-of-truth.
 *
 * Twelfth strike of the portfolio-wide public-surface hygiene pattern
 * (nine Python + three TS). Pattern series:
 *
 *   1. llm-eval-harness#25
 *   2. llm-cost-optimizer#23
 *   3. prompt-regression-suite#20
 *   4. rag-production-kit#24
 *   5. embedding-model-shootout#14
 *   6. chunking-strategies-lab#16
 *   7. python-async-llm-pipelines#19
 *   8. mcp-server-cookbook#19 (filesystem-sandbox-py)
 *   9. vector-search-at-scale#17
 *  10. agent-orchestration-platform#19 (first TS — library shape)
 *  11. nextjs-streaming-ai-patterns#15 (second TS — Next.js app shape)
 *  12. this one (third TS — library shape, exports instead of bin)
 *
 * Type-only exports (`export type { ... }`) are intentionally NOT
 * checked here — they don't exist at runtime, so `Object.keys` won't
 * see them. Future iteration if drift in type exports proves a real
 * failure mode.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import * as Index from "../src/index.js";

const ROOT = resolve(__dirname, "..");
const PACKAGE_JSON_PATH = resolve(ROOT, "package.json");

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

// README's two quoted `import { ... } from "ai-app-integration-tests"`
// snippets (lines 66 and 138 in README.md) name these five values
// between them. If any disappear from the index module, every reader
// who copy-pastes a snippet hits an ImportError equivalent.
const README_QUICKSTART_NAMES = [
  "installFromEnv",
  "uninstall",
  "expectSemanticallySimilar",
  "waitFor",
  "withRetryBudget",
] as const;

interface PackageJsonExportTarget {
  readonly import?: unknown;
  readonly types?: unknown;
}

interface PackageJson {
  readonly version?: unknown;
  readonly exports?: Record<string, PackageJsonExportTarget> | string;
}

function loadPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as PackageJson;
}

describe("public surface — package.json#version", () => {
  it("is set to a semver-ish string", () => {
    const pkg = loadPackageJson();
    expect(pkg.version, "package.json#version is missing").toBeDefined();
    expect(
      typeof pkg.version,
      `package.json#version should be a string, got ${typeof pkg.version}`,
    ).toBe("string");
    const version = pkg.version as string;
    expect(version, "package.json#version is empty").not.toBe("");
    expect(
      SEMVER_PATTERN.test(version),
      `package.json#version = ${JSON.stringify(version)} doesn't look like semver`,
    ).toBe(true);
  });
});

describe("public surface — src/index.ts value exports", () => {
  it("every value export resolves to a defined, non-null binding", () => {
    // `import * as Index` only surfaces VALUE exports (functions,
    // classes, consts). `export type { ... }` is erased at runtime
    // and intentionally out of scope here.
    const names = Object.keys(Index).filter((name) => name !== "default");
    expect(
      names.length,
      "src/index.ts re-exports no value names? — likely an import-path regression",
    ).toBeGreaterThan(0);

    const undefinedNames: string[] = [];
    const nullNames: string[] = [];
    for (const name of names) {
      const value = (Index as Record<string, unknown>)[name];
      if (value === undefined) {
        undefinedNames.push(name);
        continue;
      }
      if (value === null) {
        nullNames.push(name);
      }
    }
    expect(
      undefinedNames,
      `src/index.ts re-exports names that are undefined at runtime: ${undefinedNames.join(", ")}. ` +
        "Most likely a `export { X } from \"./Y.js\"` line references a name `./Y.js` no longer exports.",
    ).toEqual([]);
    expect(
      nullNames,
      `src/index.ts re-exports names bound to null: ${nullNames.join(", ")}. ` +
        "A re-export probably resolved to a missing or removed module member.",
    ).toEqual([]);
  });
});

describe("public surface — README quickstart imports", () => {
  it.each(README_QUICKSTART_NAMES)(
    'README quotes `%s` from "ai-app-integration-tests" — must be defined',
    (name) => {
      expect(
        (Index as Record<string, unknown>)[name],
        `\`${name}\` is no longer exported from src/index.ts. ` +
          "The README's quickstart imports it directly (line 66 or 138) — " +
          "either restore the export or update the README.",
      ).toBeDefined();
    },
  );
});

describe("public surface — package.json#exports pre-build source", () => {
  it("`.` exports map to a real pre-build source file", () => {
    const pkg = loadPackageJson();
    const exportsField = pkg.exports;
    expect(
      exportsField,
      "package.json#exports is missing — downstream `import from \"ai-app-integration-tests\"` would silently break",
    ).toBeDefined();

    // We only handle the object form (the conditional shape this
    // package ships); a string-form `exports` would need a different
    // mapping path.
    expect(
      typeof exportsField,
      `package.json#exports should be an object (conditional form), got ${typeof exportsField}`,
    ).toBe("object");
    const rootExport = (exportsField as Record<string, PackageJsonExportTarget>)["."];
    expect(rootExport, "package.json#exports['.'] is missing").toBeDefined();

    const importTarget = rootExport.import;
    expect(
      typeof importTarget,
      "package.json#exports['.'].import should be a string",
    ).toBe("string");

    // Map the dist/...js path back to its pre-build source via
    // tsconfig's rootDir = "src" + outDir = "dist".
    // dist/index.js → src/index.ts
    const distPath = importTarget as string;
    expect(
      distPath.startsWith("./dist/") || distPath.startsWith("dist/"),
      `package.json#exports['.'].import = ${JSON.stringify(distPath)} ` +
        'should start with "./dist/" or "dist/" (matches tsconfig outDir). ' +
        "If this changed, the source mapping below also needs updating.",
    ).toBe(true);

    const sourceRelative = distPath
      .replace(/^\.\//, "")
      .replace(/^dist\//, "src/")
      .replace(/\.js$/, ".ts");
    const sourceAbsolute = resolve(ROOT, sourceRelative);
    expect(
      existsSync(sourceAbsolute),
      `package.json#exports['.'].import points to ${JSON.stringify(distPath)}, ` +
        `which maps to source ${JSON.stringify(sourceRelative)} — but that file does not exist. ` +
        "Did the index source move or get renamed? Update package.json#exports to match.",
    ).toBe(true);
  });
});
