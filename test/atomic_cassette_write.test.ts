/**
 * Atomicity contract for `CassetteStore.write` (#28).
 *
 * `fs.promises.writeFile` is not atomic: the destination is opened
 * with `O_WRONLY | O_CREAT | O_TRUNC` (truncates immediately) and
 * the bytes only commit on completion. For cassettes — the
 * load-bearing contract behind the entire test repo's reliability —
 * a partial write produces one of three failures:
 *
 * 1. Zero-length: `JSON.parse` throws `Unexpected end of JSON input`.
 * 2. Mid-JSON truncation: `JSON.parse` throws at the cut.
 * 3. Truncation after schema_version + request_hash were written:
 *    parse succeeds, returns a partial object, the existing
 *    integrity guards in `CassetteStore.read` may not catch it,
 *    replay silently serves garbage.
 *
 * The fix routes `CassetteStore.write` through an `atomicWriteFile`
 * helper using `fs.open(O_WRONLY|O_CREAT|O_EXCL)` + `handle.sync()` +
 * `fs.rename`. Same shape as the cross-language siblings landed in
 * the same session: `mcp-server-cookbook#36` (TypeScript) and the
 * four Python repos (`llm-eval-harness#48`, `llm-cost-optimizer#42`,
 * `prompt-regression-suite#39`, `rag-production-kit#44`).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CassetteV1 } from "../src/cassette.js";
import { CassetteStore } from "../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-atomic-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fakeCassette(hash: string, bodyValue: string): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: hash,
    request: {
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
    },
    response: {
      kind: "non_streaming",
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, value: bodyValue }),
    },
  } as CassetteV1;
}

// ---------------------------------------------------------------------------
// Integration: `CassetteStore.write` atomicity.
// ---------------------------------------------------------------------------

describe("CassetteStore.write atomicity (#28)", () => {
  it("happy path: writes a valid cassette readable via `read`", async () => {
    const store = new CassetteStore({ dir });
    const c = fakeCassette("aaaa1111", "first");
    const written = await store.write(c);
    expect(written).toBe(path.join(dir, "aaaa1111.json"));

    const read = await store.read("aaaa1111");
    expect(read).not.toBeNull();
    expect(read!.request_hash).toBe("aaaa1111");
    expect(read!.schema_version).toBe("1");
  });

  it("auto-creates the cassette directory if it doesn't exist", async () => {
    const nested = path.join(dir, "deep", "nested");
    const store = new CassetteStore({ dir: nested });
    await store.write(fakeCassette("bbbb2222", "x"));
    expect((await store.read("bbbb2222"))!.request_hash).toBe("bbbb2222");
  });

  it("rename failure on first write leaves the destination absent (no partial cassette)", async () => {
    const store = new CassetteStore({ dir });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("simulated rename failure"));

    await expect(store.write(fakeCassette("cccc3333", "x"))).rejects.toThrow(
      /simulated rename failure/,
    );

    // The destination file must not exist — replay must see a clean
    // "no cassette" state, not a corrupt partial.
    await expect(fs.stat(path.join(dir, "cccc3333.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rename failure during overwrite preserves the pre-existing cassette bitwise (load-bearing)", async () => {
    // The most consequential invariant for this repo: a re-record
    // that fails mid-rename must leave the old cassette intact.
    // Otherwise an operator who hits Ctrl+C during a re-record on a
    // cassette they didn't even intend to re-record loses test
    // coverage silently.
    const store = new CassetteStore({ dir });
    const original = fakeCassette("dddd4444", "ORIGINAL");
    await store.write(original);

    const filePath = path.join(dir, "dddd4444.json");
    const originalBytes = await fs.readFile(filePath);

    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("simulated mid-rename failure"));

    const mutated = fakeCassette("dddd4444", "MUTATED-MUST-NOT-END-UP-ON-DISK");
    await expect(store.write(mutated)).rejects.toThrow(/simulated mid-rename failure/);

    // Bitwise identical to the pre-failure save.
    const afterFailure = await fs.readFile(filePath);
    expect(afterFailure.equals(originalBytes)).toBe(true);

    // And replay still returns the original — not the mutated copy.
    const read = await store.read("dddd4444");
    expect(read!.response.body).toContain("ORIGINAL");
    expect(read!.response.body).not.toContain("MUTATED");
  });

  it("no leftover .tmp siblings after a failed rename", async () => {
    const store = new CassetteStore({ dir });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("simulated"));

    await expect(store.write(fakeCassette("eeee5555", "x"))).rejects.toThrow(/simulated/);

    const entries = await fs.readdir(dir);
    const leftovers = entries.filter((e) => e.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("two awaited writers to the same cassette produce one winner, no corrupt blend", async () => {
    // `O_EXCL` on distinct temp filenames + atomic rename means even
    // overlapping writes serialize wholesale — the on-disk content
    // matches one writer's payload in full, never a blend.
    const store = new CassetteStore({ dir });
    const a = fakeCassette("ffff6666", "A".repeat(500));
    const b = fakeCassette("ffff6666", "B".repeat(500));
    await Promise.all([store.write(a), store.write(b)]);

    const read = await store.read("ffff6666");
    expect(read).not.toBeNull();
    const body = read!.response.body as string;
    const isA = body.includes('"' + "A".repeat(500) + '"');
    const isB = body.includes('"' + "B".repeat(500) + '"');
    expect(isA || isB).toBe(true);
    // Body must be exactly one writer's payload — never the other's
    // payload interleaved into it.
    expect(isA && isB).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `CassetteStore.read`: a present-but-malformed cassette must fail loudly with
// a clean Error, not a cryptic TypeError (#62, failure mode #3 above).
// ---------------------------------------------------------------------------

describe("CassetteStore.read rejects a non-object cassette cleanly (#62)", () => {
  it.each([
    ["null", "null"],
    ["array", "[1, 2, 3]"],
    ["string", '"hello"'],
    ["number", "42"],
  ])("a top-level %s JSON throws a clean Error, not a TypeError", async (_kind, content) => {
    const hash = "badparse";
    await fs.writeFile(path.join(dir, `${hash}.json`), content + "\n", "utf8");
    const store = new CassetteStore({ dir });

    // It must NOT be swallowed as ENOENT-null ("no cassette"), and must NOT be
    // a TypeError from dereferencing the non-object.
    await expect(store.read(hash)).rejects.toThrow(/did not parse to a cassette object/);
    const err = await store.read(hash).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it("a valid cassette still round-trips (no regression on the happy path)", async () => {
    const store = new CassetteStore({ dir });
    await store.write(fakeCassette("9999aaaa", "ok"));
    expect((await store.read("9999aaaa"))!.request_hash).toBe("9999aaaa");
  });
});

// ---------------------------------------------------------------------------
// `CassetteStore.read`: the NESTED `response` shape must also fail loudly (#77,
// sibling of #62). The top-level guard only proves `parsed` is an object;
// `rebuildResponse` then dereferences `response.headers`/`.kind`/`.frames`, so a
// present-but-wrong-typed response threw a raw TypeError at replay, one seam
// over from the #62 top-level fix.
// ---------------------------------------------------------------------------

describe("CassetteStore.read rejects a malformed nested response cleanly (#77)", () => {
  async function writeRaw(hash: string, response: unknown): Promise<void> {
    const cassette = {
      schema_version: "1",
      request_hash: hash,
      request: {
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      response,
    };
    await fs.writeFile(path.join(dir, `${hash}.json`), JSON.stringify(cassette) + "\n", "utf8");
  }

  it.each([
    ["response is null", null],
    ["response.headers is null", { kind: "non_streaming", status: 200, headers: null, body: "{}" }],
    ["response.headers is an array", { kind: "non_streaming", status: 200, headers: [], body: "{}" }],
    ["sse frames is null", { kind: "sse", status: 200, headers: {}, frames: null }],
    ["non_streaming body is not a string", { kind: "non_streaming", status: 200, headers: {}, body: 42 }],
    ["kind is unknown", { kind: "websocket", status: 200, headers: {}, body: "{}" }],
    ["kind is absent", { status: 200, headers: {}, body: "{}" }],
    // #79: status is dereferenced by rebuildResponse into `new Response(...,{status})`,
    // which throws a raw RangeError outside 200-599. The one field #77 skipped.
    ["status is out of range (0)", { kind: "non_streaming", status: 0, headers: {}, body: "{}" }],
    ["status is out of range (999)", { kind: "non_streaming", status: 999, headers: {}, body: "{}" }],
    ["status is out of range (100)", { kind: "non_streaming", status: 100, headers: {}, body: "{}" }],
    ["status is non-integer", { kind: "non_streaming", status: 200.5, headers: {}, body: "{}" }],
    ["status is a string", { kind: "non_streaming", status: "200", headers: {}, body: "{}" }],
    ["status is null", { kind: "non_streaming", status: null, headers: {}, body: "{}" }],
    ["status is absent", { kind: "non_streaming", headers: {}, body: "{}" }],
    // #82: headers is-an-object isn't enough — rebuildResponse feeds each entry
    // to Headers.set(k, v), which throws a raw TypeError for an invalid header
    // name (space/empty) or a non-string / control-char value. The entries #77
    // skipped, one seam over from status.
    ["header name has a space", { kind: "non_streaming", status: 200, headers: { "content type": "x" }, body: "{}" }],
    ["header name is empty", { kind: "non_streaming", status: 200, headers: { "": "x" }, body: "{}" }],
    ["header value has a newline", { kind: "non_streaming", status: 200, headers: { "x-ok": "a\nb" }, body: "{}" }],
    ["header value is not a string", { kind: "non_streaming", status: 200, headers: { "x-ok": 5 }, body: "{}" }],
    ["header value is null", { kind: "non_streaming", status: 200, headers: { "x-ok": null }, body: "{}" }],
  ])("%s throws a clean Error, not a TypeError", async (_label, response) => {
    const hash = "badresp";
    await writeRaw(hash, response);
    const store = new CassetteStore({ dir });
    await expect(store.read(hash)).rejects.toThrow(/malformed response/);
    const err = await store.read(hash).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it("a well-formed sse cassette still round-trips (no over-blocking)", async () => {
    const hash = "goodsse";
    await writeRaw(hash, {
      kind: "sse",
      status: 200,
      headers: { "content-type": "text/event-stream" },
      frames: ["data: {}\n\n"],
    });
    const store = new CassetteStore({ dir });
    const read = await store.read(hash);
    expect(read!.response.kind).toBe("sse");
  });

  // #79: boundary statuses the Web Response constructor accepts must still
  // round-trip — the status guard must not over-block a valid low/high/null-body
  // status (204 No Content and 599 both construct fine).
  it.each([200, 204, 599])("a cassette with valid status %i still round-trips", async (status) => {
    const hash = `goodstatus${status}`;
    await writeRaw(hash, {
      kind: "non_streaming",
      status,
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const store = new CassetteStore({ dir });
    const read = await store.read(hash);
    expect(read!.response.status).toBe(status);
  });

  // #82: a cassette with well-formed headers (real HTTP names + string values,
  // exactly what the record path emits) must still round-trip — the header-entry
  // guard must not over-block a valid recording.
  it("a cassette with well-formed headers still round-trips (no over-blocking)", async () => {
    const hash = "goodheaders";
    await writeRaw(hash, {
      kind: "non_streaming",
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "abc-123" },
      body: "{}",
    });
    const store = new CassetteStore({ dir });
    const read = await store.read(hash);
    expect(read!.response.headers["content-type"]).toBe("application/json");
  });
});
