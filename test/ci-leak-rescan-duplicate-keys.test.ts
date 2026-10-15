/**
 * The committed-cassette rescan refuses a duplicated key (#216).
 *
 * `scan-committed-cassettes` scanned `JSON.parse(text)`, and `JSON.parse` keeps
 * the LAST value of a repeated key. A cassette with a real `x-api-key` followed
 * by `"x-api-key": "[REDACTED]"` -- a hand redaction that appended instead of
 * replacing -- parsed clean, so the job passed while the credential was in the
 * committed bytes. The `grep -E` lines #171 replaced read the bytes and caught
 * it. The second test pins that the parse really is clean, so the first is not
 * passing on some other refusal.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { assertNoLeakedSecrets, type CassetteV1 } from "../src/cassette.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "scan-committed-cassettes.ts");
const FIXTURE = "a154fc0b65d0d40c779b713bd7b65138.json";
const COMMITTED = readFileSync(join(REPO_ROOT, "fixtures", FIXTURE), "utf8");
const REDACTED_LINE = '"x-api-key": "[REDACTED]"';
const KEY = `sk-ant-api03-${"A".repeat(40)}`;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** The committed fixture with `insert` placed on its own line before the redacted header. */
function withLineBeforeRedacted(insert: string): string {
  expect(COMMITTED).toContain(REDACTED_LINE);
  return COMMITTED.replace(REDACTED_LINE, `${insert},\n      ${REDACTED_LINE}`);
}

function scanText(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "aiapp-leak-rescan-dup-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, FIXTURE), text);
  return spawnSync("npx", ["tsx", SCRIPT, dir], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
}

describe("scan-committed-cassettes refuses a duplicated key (#216)", () => {
  const leaky = withLineBeforeRedacted(`"x-api-key": "${KEY}"`);

  it("refuses a credential hidden under a later duplicate of its key, naming the file and key", () => {
    const r = scanText(leaky);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(FIXTURE);
    expect(r.stderr).toContain('repeats the key "x-api-key"');
  });

  it("is a file whose bytes hold the credential and whose parse does not", () => {
    // Anti-vacuous: without the duplicate check the scanner sees only this parse.
    expect(leaky).toContain(KEY);
    const parsed = JSON.parse(leaky) as CassetteV1;
    expect(parsed.request.headers["x-api-key"]).toBe("[REDACTED]");
    expect(() => assertNoLeakedSecrets(parsed)).not.toThrow();
  });

  it("compares keys decoded, so an escape-spelled duplicate is still one", () => {
    const r = scanText(withLineBeforeRedacted(`"x\\u002dapi-key": "${KEY}"`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('repeats the key "x-api-key"');
  });

  it("fails closed on a duplicate that hides no secret: the parse still is not the file", () => {
    const r = scanText(COMMITTED.replace('"schema_version": "1",', '"schema_version": "1",\n  "schema_version": "1",'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('repeats the key "schema_version"');
  });

  it("passes the same key in different objects, a key spelled as a value, and braces inside strings", () => {
    // Anti-vacuous: a check that refused any repeated NAME would fail here --
    // `content-type` is in both header objects, each message has `role`, and
    // the strings hold quotes, commas, braces and a duplicate that is only text.
    const cassette = JSON.parse(COMMITTED) as CassetteV1 & { request: { body: Record<string, unknown> } };
    cassette.request.body.messages = [
      { role: "user", content: 'say "role", then {"a":1,"a":2} and \\' },
      { role: "assistant", content: "role" },
    ];
    const text = JSON.stringify(cassette, null, 2);
    expect(text.split('"content-type"').length - 1).toBe(2);
    const r = scanText(text);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
