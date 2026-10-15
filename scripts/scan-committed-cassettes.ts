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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import { assertNoLeakedSecrets, type CassetteV1 } from "../src/cassette.js";

/**
 * Every `*.json` under `dir`, following symlinks (#203).
 *
 * A `Dirent` describes the link, not its target, so `isFile()` and
 * `isDirectory()` are both false for a symlink, and this walk used to skip a
 * symlinked cassette, a symlinked directory of them and a dangling `.json` link
 * without a word. `CassetteStore.read` follows the link and #181 made `write`
 * write through it, so a shared-fixture layout is recorded and replayed, and
 * the gate scanned none of it. A link is now classified by what `statSync`
 * (which follows it) finds. A dangling `.json` link is collected so `problem`
 * reports it unreadable, and `seen` (real paths) makes a directory link loop end.
 */
function jsonFiles(dir: string, seen: Set<string> = new Set()): string[] {
  const real = realpathSync(dir);
  if (seen.has(real)) return [];
  seen.add(real);
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = statSync(path);
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        isFile = true; // dangling: `problem` reports it, fail closed
      }
    }
    if (isDir) out.push(...jsonFiles(path, seen));
    else if (isFile && entry.name.endsWith(".json")) out.push(path);
  }
  return out.sort();
}

/**
 * The first key `text` repeats inside one object, decoded, or `null` (#216).
 *
 * `JSON.parse` keeps the LAST value of a duplicated key, so the parse is not the
 * whole file: `"x-api-key": "sk-ant-..."` followed by `"x-api-key": "[REDACTED]"`
 * parses clean while the credential is committed. The `grep -E` lines #171
 * replaced read the bytes and caught that file. A duplicate is the one way a
 * valid JSON text holds a string its parse drops, and the recorder cannot write
 * one (`JSON.stringify`), so refusing it costs no legitimate cassette.
 *
 * `text` has already parsed, so this only tracks object nesting and string
 * tokens; a key is compared decoded, so `"x-api-key"` repeats `"x-api-key"`.
 */
function duplicateKey(text: string): string | null {
  // One entry per open container: the keys seen so far for an object, `null`
  // for an array. `expectKey` is whether the next string in an object is a key.
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const keys = stack[stack.length - 1];
      if (keys && expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (keys.has(key)) return key;
        keys.add(key);
        expectKey = false;
      }
      i = j;
    } else if (ch === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (ch === "[") {
      stack.push(null);
      expectKey = false;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      expectKey = false;
    } else if (ch === ",") {
      expectKey = stack[stack.length - 1] != null;
    }
  }
  return null;
}

/** The reason `path` must not be committed, or `null` when it is clean. */
function problem(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return `not readable: ${(err as Error).message}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return `not valid JSON: ${(err as Error).message}`;
  }
  const repeated = duplicateKey(text);
  if (repeated !== null) {
    return (
      `repeats the key ${JSON.stringify(repeated)} in one object; JSON.parse keeps only the ` +
      `last value, so the scan cannot see what the file holds. Remove the duplicate.`
    );
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
