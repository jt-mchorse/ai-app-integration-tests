/**
 * Every `out[k] = v` accumulator is null-prototype (#115).
 *
 * This is the third time this class has been found, and each time the
 * population was scoped to the axis in hand:
 *
 *   #57 / #70  body *encoding*
 *   #75        body *keys*      -> `canonicalize` got `Object.create(null)`
 *   #115       *headers*        -> three more accumulators, same mechanism
 *
 * #75's own comment states the mechanism, and it is not about bodies:
 *
 *   > a body key literally named `__proto__` is a real own-enumerable key after
 *   > `JSON.parse`, but assigning `out["__proto__"]` on a plain `{}` hits the
 *   > prototype *setter* — it mutates `out`'s prototype instead of creating an
 *   > own property, and `JSON.stringify` then omits it.
 *
 * That is a statement about `out[k] = v` on an object literal. `__proto__` is a
 * legal HTTP field name — `_` is a `tchar` under RFC 7230 — so nothing upstream
 * rejects one. Measured on the shipped `redactHeaders` before the fix:
 *
 *   in  own keys: [ '__proto__', 'content-type' ]
 *   out own keys: [ 'content-type' ]
 *
 * The harm is fidelity rather than a hash collision: `hashRequest` folds
 * method, url and body but not headers, so a dropped header cannot collide the
 * way #75's did, and it cannot leak either. What it does is record a request
 * that was never sent — and because `JSON.parse` of a committed cassette *does*
 * materialise `__proto__` as a real own property, a re-record drops a header the
 * previous recording had, changing the file without the request changing.
 *
 * The lock below **discovers** the accumulators from the source rather than
 * listing them, because a list is how the population got scoped the first three
 * times.
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";

import {
  ROOT,
  SOURCE_DIRS,
  SOURCE_EXTS,
  allSourceFiles,
  sourceFiles,
} from "./support/source-files.js";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

import { redactHeaders } from "../src/cassette.js";

// Built from pieces so the literal never appears as a key in this file's own
// object literals — the failure being tested is exactly what happens when it
// does.
const PROTO = ["__", "proto", "__"].join("");

// The population, from the repo's shared definition (#117).
//
// This was `new URL("../src", ...)` + `readdirSync(SRC_DIR).filter(...)`, which
// returns ONE LEVEL -- and `src/support/` exists. Measured with the same
// accumulator planted twice:
//
//     planted at src/support/_probe.ts   ->  10 passed (10)     invisible
//     planted at src/_probe.ts           ->  1 failed | 9 passed
//
// This file discovers accumulators *within* a file and hand-scoped the set of
// files, which is the shape it exists to prevent, one level up. The recursive
// walk was already in `architecture-doc.test.ts`; it is shared now rather than
// copied, because two locks whose populations can disagree is the same problem
// again.

/** A local `const x: T = <init>` that is later target of `x[...] = ...`. */
interface Accumulator {
  file: string;
  name: string;
  init: string;
  line: number;
}

function findAccumulators(): Accumulator[] {
  const found: Accumulator[] = [];
  for (const path of allSourceFiles()) {
    const file = relative(ROOT, path);
    const source = ts.createSourceFile(
      file,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );

    // Names that appear on the left of a computed assignment, `name[expr] = ...`.
    const computedTargets = new Set<string>();
    const walkAssignments = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isElementAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression)
      ) {
        computedTargets.add(node.left.expression.text);
      }
      ts.forEachChild(node, walkAssignments);
    };
    walkAssignments(source);

    const walkDeclarations = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        computedTargets.has(node.name.text)
      ) {
        const isObjectShaped =
          ts.isObjectLiteralExpression(node.initializer) ||
          node.initializer.getText().startsWith("Object.create");
        if (isObjectShaped) {
          found.push({
            file,
            name: node.name.text,
            init: node.initializer.getText(),
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          });
        }
      }
      ts.forEachChild(node, walkDeclarations);
    };
    walkDeclarations(source);
  }
  return found;
}

describe("every keyed accumulator is null-prototype", () => {
  it("discovers accumulators at all", () => {
    // Anti-vacuous. A walk that matched nothing would satisfy the assertion
    // below on an empty set, which is precisely how a discovery lock rots into
    // a no-op after a refactor renames a node kind.
    const accumulators = findAccumulators();
    expect(accumulators.length).toBeGreaterThanOrEqual(4);
    expect(new Set(accumulators.map((a) => a.file)).size).toBeGreaterThanOrEqual(2);
  });

  it("finds no plain object literal among them", () => {
    const plain = findAccumulators().filter((a) => a.init !== "Object.create(null)");
    expect(
      plain.map((a) => `${a.file}:${a.line} ${a.name} = ${a.init}`),
      "assigning a `__proto__` key on a plain `{}` hits the prototype setter and " +
        "silently drops the entry; use Object.create(null) (#75, #115)",
    ).toEqual([]);
  });

  it("covers the four accumulators, including the one the issue did not name", () => {
    // The discovery above is the rule; this is the regression pin, so a
    // refactor that moves a site cannot quietly reduce the population.
    //
    // #115 named three. The lock found a fourth — `headersToObject` on the
    // *response* path — which is the argument for discovering the population
    // rather than listing it, made by the lock on its first run. Its
    // consequence is one step past the issue's own analysis: a dropped
    // response header is replayed *missing* to the application under test.
    //
    // Paths are repo-relative since #117 (`src/cassette.ts`, not `cassette.ts`)
    // because the walk now covers subdirectories and a bare basename would be
    // ambiguous the moment two directories hold a file of the same name.
    const byFile = findAccumulators().map((a) => `${a.file}:${a.name}`);
    expect(byFile).toContain("src/fetch-recorder.ts:out");
    expect(byFile).toContain("src/cassette.ts:out");
    expect(byFile).toContain("src/cassette.ts:sorted");
    expect(byFile.filter((n) => n === "src/fetch-recorder.ts:out")).toHaveLength(2);
    // The count is unchanged by the wider walk: `src/support/` holds no keyed
    // accumulator today. Pinned so the widening is visibly a POPULATION change
    // and not a silent behaviour change -- a wider walk that found FEWER sites
    // would be a regression wearing a fix's clothes.
    expect(byFile).toHaveLength(5);
  });

  it("walks src/ recursively, so a subdirectory cannot fall out silently", () => {
    // The gap #117 closed, asserted against the real tree rather than a
    // fixture: `src/support/` exists and the old `readdirSync(SRC_DIR)` walk
    // returned one level, so an accumulator added there inherited nothing.
    // Measured with the same accumulator planted twice:
    //
    //     planted at src/support/_probe.ts   ->  10 passed (10)   invisible
    //     planted at src/_probe.ts           ->  1 failed | 9 passed
    const scanned = allSourceFiles().map((f) => relative(ROOT, f));
    expect(scanned.some((f) => f.startsWith("src/"))).toBe(true);
    expect(
      scanned.some((f) => f.startsWith("src/support/")),
      "src/support/ must be in the population; it is what the flat walk missed",
    ).toBe(true);
    // Anti-vacuous for the assertion above: a walk that returned every file in
    // the repo would also satisfy it while checking nothing.
    expect(scanned.every((f) => f.startsWith("src/"))).toBe(true);
    expect(scanned.every((f) => f.endsWith(".ts") || f.endsWith(".tsx"))).toBe(true);
  });

  it("shares one definition of the population with the architecture-doc lock", () => {
    // Not a second correct copy. Two locks whose populations can quietly
    // disagree is the same shape one level up from the thing this file checks,
    // and it is how `src/support/` fell out in the first place: the recursive
    // walk already existed in `architecture-doc.test.ts` and was private to it.
    expect([...SOURCE_DIRS]).toEqual(["src"]);
    expect([...SOURCE_EXTS]).toEqual([".ts", ".tsx"]);
    // `sourceFiles` is the shared walk itself, exercised directly so that
    // renaming it breaks here rather than silently reducing the population.
    expect(sourceFiles("src").length).toBe(allSourceFiles().length);
  });
});

describe("redactHeaders keeps a __proto__ header", () => {
  it("preserves it as an own enumerable key", () => {
    const headers = JSON.parse(`{"${PROTO}": "evil", "content-type": "application/json"}`);
    expect(Object.keys(headers)).toEqual([PROTO, "content-type"]);

    const out = redactHeaders(headers);
    expect(Object.keys(out).sort()).toEqual([PROTO, "content-type"].sort());
    expect(JSON.parse(JSON.stringify(out))[PROTO]).toBe("evil");
  });

  it("does not pollute the prototype of anything", () => {
    const headers = JSON.parse(`{"${PROTO}": {"polluted": true}}`);
    redactHeaders(headers);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("still redacts, sorts and lowercases with the key present", () => {
    const headers = JSON.parse(
      `{"${PROTO}": "evil", "Authorization": "Bearer sk-secret", "content-type": "text/plain"}`,
    );
    const out = redactHeaders(headers);
    expect(out.authorization).toBe("[REDACTED]");
    expect(Object.keys(out)).toEqual([...Object.keys(out)].sort());
    expect(out[PROTO]).toBe("evil");
  });

  it("round-trips through JSON the way a cassette does", () => {
    const headers = JSON.parse(`{"${PROTO}": "evil", "x-a": "1"}`);
    const once = redactHeaders(headers);
    const reparsed = JSON.parse(JSON.stringify(once));
    const twice = redactHeaders(reparsed);
    // The re-record stability the issue names: recording a committed cassette
    // again must not drop a header the previous recording had.
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

describe("ordinary headers are byte-identical", () => {
  it("produces the same JSON as a plain-object accumulator would", () => {
    // #75's claim, run rather than repeated: `Object.keys`/`.sort()`/
    // `JSON.stringify` are unchanged on null-prototype objects, so nothing but
    // the `__proto__` case moves.
    const cases: Record<string, string>[] = [
      { "content-type": "application/json" },
      { "X-Request-Id": "abc", accept: "*/*", "Content-Type": "text/plain" },
      { authorization: "Bearer sk-secret", cookie: "a=b" },
      {},
      { z: "1", a: "2", m: "3" },
    ];
    for (const headers of cases) {
      const legacy: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        const key = k.toLowerCase();
        legacy[key] = ["authorization", "x-api-key", "cookie", "set-cookie"].includes(key)
          ? "[REDACTED]"
          : v;
      }
      const legacySorted: Record<string, string> = {};
      for (const k of Object.keys(legacy).sort()) legacySorted[k] = legacy[k];

      expect(JSON.stringify(redactHeaders(headers))).toBe(JSON.stringify(legacySorted));
    }
  });
});

describe("the response header path, which #115 did not name", () => {
  it("is reachable: WHATWG Headers accepts __proto__ as a field name", () => {
    // `_` is a `tchar` under RFC 7230, so the name is legal and nothing
    // upstream rejects it. Asserted rather than assumed, because "can this
    // even happen" is the question that made the issue `priority:low`.
    const h = new Headers();
    h.set(PROTO, "evil");
    expect(h.get(PROTO)).toBe("evil");
  });

  it("keeps the header through the shipped forEach accumulation", () => {
    const h = new Headers();
    h.set(PROTO, "evil");
    h.set("content-type", "text/plain");

    const legacy: Record<string, string> = {};
    h.forEach((v, k) => {
      legacy[k.toLowerCase()] = v;
    });
    // The defect, reproduced against the shape the module used to have: one
    // header in, zero own keys out.
    expect(Object.keys(legacy)).toEqual(["content-type"]);

    const fixed: Record<string, string> = Object.create(null);
    h.forEach((v, k) => {
      fixed[k.toLowerCase()] = v;
    });
    expect(Object.keys(fixed).sort()).toEqual([PROTO, "content-type"].sort());
    expect(JSON.stringify(redactHeaders(fixed))).toContain(PROTO);
  });
});
