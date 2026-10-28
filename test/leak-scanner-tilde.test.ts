/**
 * A credential containing `~` is refused like any other (#261).
 *
 * `CREDENTIAL_VALUE` and the `Bearer` pattern matched `[A-Za-z0-9_\-.+/=]`, with
 * no `~`. RFC 6750's `b64token` and RFC 3986's unreserved set both include it,
 * and every Microsoft Entra ID client secret carries one at position 5
 * (`xxxNQ~…`). A `~` within a value's first 24 characters ended the match, so
 * the request went out live, the secret was written to the cassette, and the
 * committed-cassette rescan passed it. The same value with `x` for `~` was
 * refused before the live call.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CassetteV1, assertNoLeakedSecrets } from "../src/cassette.js";
import { CassetteStore, createRecorderFetch } from "../src/index.js";

const HOSTS = new Set(["login.example.com"]);
const TOKEN_URL = "https://login.example.com/oauth2/v2.0/token";

// Built from parts so this file is not a leak. Entra-shaped: `~` at index 5.
const tail = ["Xy7", "kLmN0pQrStUvWxYz", "AbCdEfGhIjKl12"].join("_");
const SECRETS: Array<readonly [string, string]> = [
  ["~ at index 5 (Entra)", `aB38Q~${tail}`],
  ["~ first", `~aB38Q${tail}`],
  ["~ at index 23", `${`aB38Q${tail}`.slice(0, 23)}~${`aB38Q${tail}`.slice(23)}`],
  ["several ~", `a~B~3~8~Q~${tail}`],
];

function cassette(body: unknown, url = TOKEN_URL, responseBody = '{"ok":true}'): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "0".repeat(32),
    request: { method: "POST", url, headers: {}, body },
    response: { kind: "non_streaming", status: 200, headers: {}, body: responseBody },
    recorded_at: "2026-10-28T00:00:00Z",
  } as CassetteV1;
}

const CHANNELS: Array<readonly [string, (s: string) => CassetteV1]> = [
  ["form client_secret, raw", (s) => cassette(`grant_type=client_credentials&client_secret=${s}`)],
  ["form client_secret, percent-encoded", (s) => cassette(`client_secret=${encodeURIComponent(s)}`)],
  ["JSON client_secret", (s) => cassette({ client_secret: s })],
  ["response access_token", (s) => cassette(null, TOKEN_URL, JSON.stringify({ access_token: s }))],
  ["URL ?access_token=", (s) => cassette(null, `${TOKEN_URL}?access_token=${s}`)],
  ["Bearer in a body", (s) => cassette(`Authorization: Bearer ${s}`)],
];

describe("the scanner refuses a ~-bearing credential in every channel (#261)", () => {
  for (const [where, build] of CHANNELS) {
    it.each(SECRETS)(`${where}: %s`, (_label, secret) => {
      expect(() => assertNoLeakedSecrets(build(secret))).toThrow(/unredacted secret/);
    });
  }

  it("control: a short ~ value under a credential name is still not credential-shaped", () => {
    expect(() => assertNoLeakedSecrets(cassette("client_secret=a~b"))).not.toThrow();
  });

  it("control: a ~ in an ordinary path or value is not a credential", () => {
    expect(() =>
      assertNoLeakedSecrets(cassette({ path: "~/projects/notes.md", note: "about ~5 minutes" })),
    ).not.toThrow();
  });
});

let dir: string;
let calls: number;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-tilde-"));
  calls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the recorder refuses an Entra client-credentials request before the live call (#261)", () => {
  it("is refused with no upstream call and nothing written", async () => {
    const upstream = (async () => {
      calls += 1;
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const record = createRecorderFetch({ upstream, store: new CassetteStore({ dir }), hosts: HOSTS });
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "abc",
      client_secret: SECRETS[0][1],
      scope: "https://graph.microsoft.com/.default",
    });
    await expect(record(TOKEN_URL, { method: "POST", body })).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });
});
