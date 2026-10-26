/**
 * A credential name with a camelCase prefix is refused before the live call
 * (#251, follow-up to #246/#248).
 *
 * #248 put `(?<![A-Za-z0-9])` in front of the compound credential names, which
 * counts `-` and `_` as joins and blocks every letter. camelCase is the usual
 * join in a JS/TS JSON body, so `openaiApiKey`, `openAIApiKey` (LangChain's
 * parameter), `xApiKey`, `googleApiKey` and `userAccessToken` went live and were
 * written to the cassette, and the committed-cassette rescan passed them, while
 * `apiKey` and `openai_api_key` were refused. Every REFUSE row below went live
 * and was written on `main` (060a20c), Node 25.5.
 *
 * The rule now: a compound name whose first letter is uppercase, after a letter
 * or digit, is a camelCase join. All-lowercase glue (`myapikey`) still is not,
 * and the generic nouns `key`/`token` get no camelCase join, as they get no `_`
 * join (`cacheKey` like `cache_key`). The RECORDED table pins that.
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

// The issue's five, then names #250 added. Each went live and was written on main.
const REFUSE = [
  "openaiApiKey",
  "openAIApiKey",
  "xApiKey",
  "googleApiKey",
  "userAccessToken",
  "userPassword",
  "clientAssertion",
  "awsSecretAccessKey",
  "myAPIKEY",
];

// Recorded before and after. The first four are the issue's controls.
const RECORDED = ["myapikey", "v2accesstoken", "cache_key", "idempotency_key", "cacheKey", "nextPageToken", "monkey"];

let dir: string;
let calls: number;

function recorder() {
  const upstream = (async () => {
    calls += 1;
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
}

function send(name: string, where: "body" | "query" = "body"): Promise<Response> {
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

/** The cassette the unfixed recorder wrote for `name` in a JSON body. */
function cassette(name: string): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "0".repeat(32),
    request: { method: "POST", url: URL_, headers: { "content-type": "application/json" }, body: { [name]: FAKE_OPAQUE } },
    response: { kind: "non_streaming", status: 200, headers: {}, body: '{"ok":true}' },
    recorded_at: "2026-10-26T00:00:00Z",
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-camel-prefix-"));
  calls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a camelCase-prefixed credential name is refused before the live call (#251)", () => {
  it.each(REFUSE)("%s in a JSON body", async (name) => {
    await expect(send(name)).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
    expect(await written()).toHaveLength(0);
  });

  it("openaiApiKey in the query string", async () => {
    await expect(send("openaiApiKey", "query")).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
  });

  it("the committed-cassette rescan refuses each one and passes the controls", async () => {
    // One spawn over every row: each REFUSE file named, no control file named.
    const fixtures = path.join(dir, "fixtures");
    await fs.mkdir(fixtures);
    // The index keeps `openaiApiKey` and `openAIApiKey` apart on a
    // case-insensitive filesystem (macOS).
    const leaks = REFUSE.map((n, i) => `leak-${i}-${n}.json`);
    const clean = RECORDED.map((n) => `clean-${n}.json`);
    for (const [i, name] of REFUSE.entries()) {
      await fs.writeFile(path.join(fixtures, leaks[i]), JSON.stringify(cassette(name)));
    }
    for (const [i, name] of RECORDED.entries()) {
      await fs.writeFile(path.join(fixtures, clean[i]), JSON.stringify(cassette(name)));
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
  it.each(["apiKey", "openai_api_key", "ApiKey"])("%s was already refused", async (name) => {
    await expect(send(name)).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
  });

  it.each(RECORDED)("%s still records", async (name) => {
    await send(name);
    expect(calls).toBe(1);
    expect(await written()).toHaveLength(1);
  });

  it("the camelCase join needs the credential-shaped value too", () => {
    // The length bound applies to the camelCase form as to the others.
    const short = cassette("openaiApiKey");
    short.request.body = { openaiApiKey: "short-value" };
    expect(() => assertNoLeakedSecrets(short)).not.toThrow();
  });
});
