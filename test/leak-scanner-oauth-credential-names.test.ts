/**
 * The OAuth credential parameters and the common credential header names are
 * refused before the live call (#250, follow-up to #113 and #246).
 *
 * The `key=`-family pattern listed four names (`api…key`, `access…token`,
 * `auth…token`, `subscription…key`). An ordinary OAuth token request carries
 * `client_secret`, `refresh_token` or `password`, and each went live and was
 * written to the cassette, and the committed-cassette rescan passed it. Every
 * REFUSE row below went live and was written on `main` (e5bd908), Node 25.5;
 * `access_token`, `x-auth-key` and `x-access-key` were already refused.
 *
 * The names come from the specs (RFC 6749, 7009, 7521/7523, 8693, OIDC) and
 * vendor docs; the comment above the pattern in `src/cassette.ts` lists them.
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
const HOSTS = new Set(["auth.example.com"]);
const TOKEN_URL = "https://auth.example.com/oauth/token";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// [label, form-urlencoded body]. Each went live and was written on main.
const GRANTS: Array<readonly [string, string]> = [
  ["client_credentials", `grant_type=client_credentials&client_id=abc&client_secret=${FAKE_OPAQUE}`],
  ["refresh_token", `grant_type=refresh_token&refresh_token=${FAKE_OPAQUE}`],
  ["password", `grant_type=password&username=u&password=${FAKE_OPAQUE}`],
  ["jwt-bearer assertion", `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${FAKE_OPAQUE}`],
  ["client_assertion", `grant_type=client_credentials&client_assertion=${FAKE_OPAQUE}`],
  ["token exchange", `grant_type=token-exchange&subject_token=${FAKE_OPAQUE}&actor_token=${FAKE_OPAQUE}`],
  ["revocation", `token=${FAKE_OPAQUE}`],
  ["id_token", `id_token=${FAKE_OPAQUE}`],
];

// Request header names. Each was recorded with its value on main.
const HEADERS = ["x-api-token", "private-token", "x-client-secret", "x-vault-token", "x-api-secret"];

// JSON body names from vendor SDKs and config. Each went live on main.
const BODY_NAMES = ["db_password", "aws_secret_access_key", "secret_key", "session_token", "api_token", "client-secret"];

// [label, form body]. Each records, before and after.
const CONTROLS: Array<readonly [string, string]> = [
  // The length bound still applies: a short value under a credential name is
  // not credential-shaped.
  ["short password", "grant_type=password&username=u&password=hunter2"],
  // `token` and `secret` take bare `key`'s `\b`, so an underscore-joined
  // pagination name is a name of its own.
  ["next_page_token", `next_page_token=${FAKE_OPAQUE}`],
  ["secret_id", `secret_id=${FAKE_OPAQUE}`],
  // A name merely containing the noun, glued to a letter.
  ["mytoken", `mytoken=${FAKE_OPAQUE}`],
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

function postForm(body: string): Promise<Response> {
  return recorder()(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function postJson(obj: Record<string, string>): Promise<Response> {
  return recorder()(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  });
}

async function written(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
}

/** The cassette the unfixed recorder wrote for a form body. */
function cassette(body: string, responseBody = '{"ok":true}'): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: "0".repeat(32),
    request: {
      method: "POST",
      url: TOKEN_URL,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    response: { kind: "non_streaming", status: 200, headers: {}, body: responseBody },
    recorded_at: "2026-10-26T00:00:00Z",
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-oauth-names-"));
  calls = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("an OAuth credential parameter is refused before the live call (#250)", () => {
  it.each(GRANTS)("%s grant", async (_label, body) => {
    await expect(postForm(body)).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
    expect(await written()).toHaveLength(0);
  });

  it.each(HEADERS)("request header %s", async (name) => {
    await expect(recorder()(TOKEN_URL, { headers: { [name]: FAKE_OPAQUE } })).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
    expect(await written()).toHaveLength(0);
  });

  it.each(BODY_NAMES)("JSON body name %s", async (name) => {
    await expect(postJson({ [name]: FAKE_OPAQUE })).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
    expect(await written()).toHaveLength(0);
  });

  it("an OAuth token response carrying refresh_token and id_token is refused", () => {
    const response = JSON.stringify({ token_type: "Bearer", refresh_token: FAKE_OPAQUE, id_token: FAKE_OPAQUE });
    expect(() => assertNoLeakedSecrets(cassette("grant_type=authorization_code", response))).toThrow(
      "unredacted secret",
    );
  });

  it("the committed-cassette rescan refuses each grant and passes the controls", async () => {
    // One spawn over every row: each grant file named, no control file named.
    const fixtures = path.join(dir, "fixtures");
    await fs.mkdir(fixtures);
    const leaks = GRANTS.map(([label]) => `leak-${label.replace(/\W+/g, "-")}.json`);
    const cleanBodies = CONTROLS.map(([, body]) => body);
    const clean = CONTROLS.map(([label]) => `clean-${label.replace(/\W+/g, "-")}.json`);
    for (const [i, [, body]] of GRANTS.entries()) {
      await fs.writeFile(path.join(fixtures, leaks[i]), JSON.stringify(cassette(body)));
    }
    for (const [i, body] of cleanBodies.entries()) {
      await fs.writeFile(path.join(fixtures, clean[i]), JSON.stringify(cassette(body)));
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
  it.each(CONTROLS)("%s still records", async (_label, body) => {
    await postForm(body);
    expect(calls).toBe(1);
    expect(await written()).toHaveLength(1);
  });

  it("`code` is not a credential name: an error body's long error code still records", () => {
    // RFC 6749's authorization `code` is left out on purpose; `code` is the
    // error-code field of ordinary JSON error responses.
    const response = JSON.stringify({ error: { code: "context_length_exceeded_for_this_model" } });
    expect(() => assertNoLeakedSecrets(cassette("grant_type=x", response))).not.toThrow();
  });

  it.each([
    ["access_token", `access_token=${FAKE_OPAQUE}`],
    ["x-auth-key", `x-auth-key=${FAKE_OPAQUE}`],
  ] as const)("%s was already refused", async (_label, body) => {
    await expect(postForm(body)).rejects.toThrow("unredacted secret");
    expect(calls).toBe(0);
  });
});
