/**
 * File-mode contract for `CassetteStore.write` (the private `atomicWriteFile`
 * in `src/io.ts`), #137 / portfolio-ops#81.
 *
 * The helper used to open its temp file with an explicit `0o600`, and
 * `fs.rename` carries the temp's mode onto the target. Every cassette came out
 * owner-only regardless of umask, and re-recording over an existing 0644
 * cassette demoted it to 0600. The `fs.writeFile` the helper replaced (#28)
 * did neither.
 *
 * Pinned here: a new cassette gets `0o666 & ~umask` (the kernel applies the
 * umask), and an overwrite keeps the target's existing permission bits. Each
 * test sets the umask it needs and restores the previous one in `finally`,
 * because the umask is process-global. vitest 2's default pool is `forks`, so
 * `process.umask(mask)` is allowed here (it throws inside a worker thread).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CassetteStore, createRecorderFetch } from "../src/index.js";
import { type CassetteV1 } from "../src/cassette.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-mode-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function fakeCassette(hash: string): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: hash,
    request: { method: "POST", url: "https://api.example.com/v1", headers: {}, body: "{}" },
    response: { kind: "non_streaming", status: 200, headers: {}, body: "{}" },
    recorded_at: "2026-10-01T00:00:00Z",
  } as unknown as CassetteV1;
}

async function modeOf(p: string): Promise<number> {
  return (await fs.stat(p)).mode & 0o7777;
}

async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
  const prev = process.umask(mask);
  try {
    return await fn();
  } finally {
    process.umask(prev);
  }
}

describe("CassetteStore.write — new-file mode follows the umask (#137)", () => {
  it("umask 022 → a new cassette is 0644, the same as a plain fs.writeFile", async () => {
    await withUmask(0o022, async () => {
      const plain = path.join(dir, "plain.json");
      await fs.writeFile(plain, "x");
      const written = await new CassetteStore({ dir }).write(fakeCassette("aaaa1111"));
      expect(await modeOf(written)).toBe(0o644);
      expect(await modeOf(written)).toBe(await modeOf(plain));
    });
  });

  it("umask 077 → a new cassette is 0600 (the umask still narrows it)", async () => {
    await withUmask(0o077, async () => {
      const written = await new CassetteStore({ dir }).write(fakeCassette("bbbb2222"));
      expect(await modeOf(written)).toBe(0o600);
    });
  });
});

describe("CassetteStore.write — an overwrite keeps the cassette's existing mode (#137)", () => {
  for (const existing of [0o644, 0o600, 0o640]) {
    it(`overwrite of a 0${existing.toString(8)} cassette stays 0${existing.toString(8)}`, async () => {
      // umask 022 so a mode-preserving overwrite and a umask-derived one
      // differ for 0600 and 0640. A fix that only switched to 0o666 without
      // the chmod would turn both into 0644.
      await withUmask(0o022, async () => {
        const target = path.join(dir, "cccc3333.json");
        await fs.writeFile(target, "old");
        await fs.chmod(target, existing);
        const written = await new CassetteStore({ dir }).write(fakeCassette("cccc3333"));
        expect(written).toBe(target);
        expect(await modeOf(target)).toBe(existing);
        expect((await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      });
    });
  }
});

describe("createRecorderFetch records a cassette with the umask-derived mode (real caller, #137)", () => {
  it("umask 022 → the recorded cassette is 0644", async () => {
    await withUmask(0o022, async () => {
      const upstream: typeof fetch = async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const recorder = createRecorderFetch({
        upstream,
        store: new CassetteStore({ dir }),
        hosts: new Set(["api.anthropic.com"]),
      });
      await recorder("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
      });
      const files = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
      expect(files).toHaveLength(1);
      expect(await modeOf(path.join(dir, files[0] as string))).toBe(0o644);
    });
  });
});
