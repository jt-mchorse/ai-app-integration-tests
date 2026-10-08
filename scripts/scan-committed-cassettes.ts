/**
 * The CI half of D-004's two-layer leak check (#171).
 *
 * Runs the recorder's own `assertNoLeakedSecrets` over every `*.json` under a
 * directory (default `fixtures/`), so the layer that re-checks committed
 * cassettes is the same scanner that refused to write them.
 *
 * The `no-leaked-secrets` job used to be two hand-written `grep -E` lines. They
 * covered 2 of the scanner's 7 patterns (`sk-` and `Bearer`, not `AIza`,
 * `Basic`, URL userinfo or `key=`), and both still ended in the trailing `\b`
 * that #60 removed from the scanner because it lets a credential ending in a
 * non-word char (`-`, `=` padding) slip. A cassette that reached git without
 * the recorder — hand-edited, written by an older recorder, copied in — passed
 * CI while carrying a credential the recorder itself refuses. A second copy of
 * a rule drifts; importing the one rule cannot.
 *
 * Exit codes: 0 every cassette is clean; 1 at least one cassette carries a
 * secret or is not a readable cassette (fail closed); 2 the directory does not
 * exist (a gate pointed at a typo must not pass by scanning nothing).
 *
 * Invoked as `npx tsx scripts/scan-committed-cassettes.ts [dir]`, like
 * `scripts/missing_cassette_demo.ts`, so it needs neither a built `dist/` nor
 * Node's native TypeScript support.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { assertNoLeakedSecrets, type CassetteV1 } from "../src/cassette.js";

function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
  }
  return out.sort();
}

/** The reason `path` must not be committed, or `null` when it is clean. */
function problem(path: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return `not valid JSON: ${(err as Error).message}`;
  }
  const c = parsed as Partial<CassetteV1> | null;
  if (typeof c !== "object" || c === null || typeof c.request !== "object" || c.request === null) {
    return "not a cassette (no `request` object), so it cannot be scanned";
  }
  try {
    assertNoLeakedSecrets(c as CassetteV1);
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

const dir = process.argv[2] ?? "fixtures";
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`scan-committed-cassettes: ${JSON.stringify(dir)} is not a directory`);
  process.exit(2);
}

const files = jsonFiles(dir);
let bad = 0;
for (const path of files) {
  const why = problem(path);
  if (why === null) continue;
  bad += 1;
  console.error(`::error file=${path}::${why}`);
}
if (bad > 0) {
  console.error(`${bad} of ${files.length} cassette(s) under ${dir}/ refused.`);
  process.exit(1);
}
console.log(`no leaked secrets found in ${files.length} cassette(s) under ${dir}/`);
