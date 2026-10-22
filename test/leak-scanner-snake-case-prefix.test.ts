/**
 * A credential name with a snake_case prefix is refused before the live call
 * (#246, follow-up to #113).
 *
 * The `key=`-family pattern began with `\b`. `_` is a word character, so there
 * is no boundary inside `x_api_key` before `api`, while there is one inside
 * `x-api-key`. `x_api_key`, `openai_api_key`, `x_access_token` and
 * `subscription_key` were sent live and written to the cassette, and the
 * committed-cassette rescan (`scripts/scan-committed-cassettes.ts`, the same
 * `assertNoLeakedSecrets`) passed them. Every REFUSE row below went live and was
 * written on `main` (0e76ebc), Node 25.5 and Node 20.9.
 *
 * The rule now: a compound credential name (`api…key`, `access…token`,
 * `auth…token`, `subscription…key`) matches unless a letter or digit comes
 * right before it. Bare `key` keeps `\b`, which is what stops `monkey=`, so the
 * `_`/`-` asymmetry stays for bare `key` only. The BARE_KEY table pins it in
 * both directions.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";
import { CassetteStore, createRecorderFetch } from "../src/index.js";

// No prefix of its own, so only the name marks it. Built from parts so this
// file is not a leak.
const FAKE_OPAQUE = ["fake", "opaque", "z".repeat(24)].join("");
const HOSTS = new Set(["api.example.com"]);
const URL_ = "https://api.example.com/v1/x";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A request carrying `name` → FAKE_OPAQUE: in a JSON body, or in the query. */
type Where = "body" | "query";

// [name, where]. Each went live and was written on main.
const REFUSE: Array<readonly [string, Where]> = [
  ["x_api_key", "body"],
  ["openai_api_key", "body"],
  ["x_access_token", "body"],
  ["my_auth_token", "body"],
  ["subscription_key", "query"],
  ["x_api_key", "query"],
];

// Bare `key` behind a prefix: today's verdicts, kept on purpose and pinned so a
// later edit to the rule shows up as a red row. `_` joins a word, so
// `cache_key` is a name of its own; `-` does not.
const BARE_KEY: Array<readonly [string, "refused" | "recorded"]> = [
  ["monkey", "recorded"],
  ["cache_key", "recorded"],
  ["idempotency_key", "recorded"],
  ["cache-key", "refused"],
  ["idempotency-key", "refused"],
];

let dir: string;
let calls: number;

function recorder() {
  const upstream = (async () => {
    calls += 1;
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
}

function send(name: string, where: Where): Promise<Response> {
  const fetchRec = recorder();
  if (where === "query") return fetchRec(`${URL_}?${name}=${FAKE_OPAQUE}`);
  return fetchRec(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [name]: FAKE_OPAQUE }),
  });
}

async function written(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
}

/** The cassette the unfixed recorder wrote for `name`. */
function cassette(name: string, where: Where): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "0".repeat(32),
    request: {
      method: where === "query" ? "GET" : "POST",
      url: where === "query" ? `${URL_}?${name}=${FAKE_OPAQUE}` : URL_,
      headers: where === "query" ? {} : { "content-type": "application/json" },
      body: where === "query" ? null : { [name]: FAKE_OPAQUE },
    },
    response: { kind: "non_streaming", status: 200, headers: {}, body: '{"ok":true}' },
    recorded_at: "2026-10-22T00:00:00Z",
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-snake-prefix-"));
  calls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a snake_case-prefixed credential name is refused before the live call (#246)", () => {
  it.each(REFUSE)("%s in the %s", async (name, where) => {
    await expect(send(name, where)).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
    expect(await written()).toHaveLength(0);
  });

  it("the committed-cassette rescan refuses each one and passes the bare-key controls", async () => {
    // One spawn over every row: each REFUSE file named, no control file named.
    const fixtures = path.join(dir, "fixtures");
    await fs.mkdir(fixtures);
    const leaks = REFUSE.map(([name, where]) => `leak-${where}-${name}.json`);
    const clean = ["monkey", "cache_key", "idempotency_key"].map((n) => `clean-${n}.json`);
    for (const [i, [name, where]] of REFUSE.entries()) {
      await fs.writeFile(path.join(fixtures, leaks[i]), JSON.stringify(cassette(name, where)));
    }
    for (const [i, name] of ["monkey", "cache_key", "idempotency_key"].entries()) {
      await fs.writeFile(path.join(fixtures, clean[i]), JSON.stringify(cassette(name, "body")));
    }
    const r = spawnSync("npx", ["tsx", path.join(REPO_ROOT, "scripts", "scan-committed-cassettes.ts"), fixtures], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(r.status).toBe(1);
    for (const f of leaks) expect(r.stderr).toContain(f);
    for (const f of clean) expect(r.stderr).not.toContain(f);
    expect(r.stderr).toContain(`${leaks.length} of ${leaks.length + clean.length}`);
  });
});

describe("controls", () => {
  it.each([
    ["api_key", "body"],
    ["x-api-key", "body"],
    ["subscription-key", "query"],
  ] as const)("%s in the %s was already refused", async (name, where) => {
    await expect(send(name, where)).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
  });

  it.each(BARE_KEY)("bare `key` behind a prefix, %s: %s", async (name, verdict) => {
    if (verdict === "refused") {
      await expect(send(name, "body")).rejects.toThrow("unredacted secret");
      expect(calls).toBe(0);
    } else {
      await send(name, "body");
      expect(calls).toBe(1);
      expect(await written()).toHaveLength(1);
    }
  });

  it("a compound name glued to a letter is not a credential name", () => {
    // Pins the lookbehind itself: dropping it (any prefix at all) would refuse this.
    expect(() => assertNoLeakedSecrets(cassette("myapikey", "body"))).not.toThrow();
    expect(() => assertNoLeakedSecrets(cassette("v2accesstoken", "body"))).not.toThrow();
  });
});
