/**
 * The recorder sends and hashes the method `fetch` would send (#205).
 *
 * `normalizeRequest` upper-cased every method and the recorder sent that
 * upstream. `fetch` upper-cases only DELETE/GET/HEAD/OPTIONS/POST/PUT; any other
 * method is case-sensitive and goes on the wire as written. So a `patch` call
 * reached the upstream as `PATCH` -- the live call fails, the recorded one
 * succeeded and replayed green -- and `patch`/`PATCH` shared one cassette.
 *
 * The upstream is a stub that reads the method the way `fetch` resolves it
 * (`new Request(input, init).method`), because Node's HTTP server answers a
 * lower-case `patch` with 400 before any handler sees it.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch, createReplayerFetch } from "../src/index.js";

const URL_ = "https://api.anthropic.com/v1/x";
const HOSTS = new Set(["api.anthropic.com"]);
let dir: string;
let store: CassetteStore;
let sent: string[];

const upstream: typeof fetch = async (input, init) => {
  const method = new Request(input, init).method;
  sent.push(method);
  return new Response(JSON.stringify({ method }), { headers: { "content-type": "application/json" } });
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-method-"));
  store = new CassetteStore({ dir });
  sent = [];
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const recorder = () => createRecorderFetch({ upstream, store, hosts: HOSTS });
const replayer = () => createReplayerFetch({ store, hosts: HOSTS });
const cassettes = async () => (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));

describe("request method case (#205)", () => {
  it.each(["patch", "Patch", "purge"])("a %s call reaches the upstream as written", async (method) => {
    await recorder()(URL_, { method, body: "a" });
    expect(sent).toEqual([method]);
  });

  it("a Request carrying 'patch' reaches the upstream as 'patch'", async () => {
    await recorder()(new Request(URL_, { method: "patch", body: "a" }));
    expect(sent).toEqual(["patch"]);
  });

  it("'patch' and 'PATCH' are two cassettes, and each replays its own response", async () => {
    await recorder()(URL_, { method: "patch", body: "a" });
    await recorder()(URL_, { method: "PATCH", body: "a" });
    expect(await cassettes()).toHaveLength(2);
    const lower = await replayer()(URL_, { method: "patch", body: "a" });
    expect(await lower.json()).toEqual({ method: "patch" });
  });

  it("a Request carrying 'patch' shares the cassette of fetch(url, {method: 'patch'})", async () => {
    await recorder()(URL_, { method: "patch", body: "a" });
    const res = await replayer()(new Request(URL_, { method: "patch", body: "a" }));
    expect(await res.json()).toEqual({ method: "patch" });
  });

  it("a method fetch refuses is refused, not upper-cased into a valid one", async () => {
    // U+017F LATIN SMALL LETTER LONG S upper-cases to `S` under toUpperCase.
    const method = `po${String.fromCodePoint(0x17f)}t`;
    await expect(recorder()(URL_, { method, body: "a" })).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  // Controls: the six methods fetch normalizes still normalize, so no hash moves.
  it.each(["post", "Get", "delete", "put", "options", "head"])(
    "%s still hashes like its upper-case spelling",
    async (method) => {
      const body = /^(get|head)$/i.test(method) ? undefined : "a";
      await recorder()(URL_, { method, body });
      await recorder()(URL_, { method: method.toUpperCase(), body });
      expect(await cassettes()).toHaveLength(1);
      expect(sent).toEqual([method.toUpperCase(), method.toUpperCase()]);
    },
  );

  it("the committed fixture still replays under its own name", async () => {
    const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures");
    const [name] = (await fs.readdir(fixtures)).filter((f) => f.endsWith(".json"));
    const cassette = JSON.parse(await fs.readFile(path.join(fixtures, name), "utf8"));
    const res = await createReplayerFetch({ store: new CassetteStore({ dir: fixtures }), hosts: HOSTS })(
      cassette.request.url,
      { method: "post", headers: cassette.request.headers, body: JSON.stringify(cassette.request.body) },
    );
    expect(res.status).toBe(200);
  });
});
