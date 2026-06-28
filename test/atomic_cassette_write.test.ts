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
