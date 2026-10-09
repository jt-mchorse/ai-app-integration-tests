/**
 * CassetteStore.write writes THROUGH a symlinked cassette, as `fs.writeFile`
 * does (#181).
 *
 * `atomicWriteFile` renamed its temp file onto the link, replacing it with a
 * regular file, while `CassetteStore.read` follows the link. Measured on main:
 * after a write, the fixture entry was no longer a symlink and the shared file
 * it pointed at still held the old bytes.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CassetteV1 } from "../src/cassette.js";
import { CassetteStore } from "../src/index.js";

const HASH = "a".repeat(32);
let root: string;
let fixtures: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "aiit-symlink-"));
  fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function cassette(text: string): CassetteV1 {
  return {
    schema_version: "1",
    request_hash: HASH,
    request: { method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {}, body: null },
    response: { kind: "non_streaming", status: 200, headers: {}, body: text },
    recorded_at: "2026-10-09T00:00:00.000Z",
  } as CassetteV1;
}

const entry = () => path.join(fixtures, `${HASH}.json`);

describe("CassetteStore.write through a symlink (#181)", () => {
  it("keeps the link and updates the file it points at", async () => {
    const shared = path.join(root, "shared.json");
    await fs.writeFile(shared, "OLD\n");
    await fs.symlink(shared, entry());
    await new CassetteStore({ dir: fixtures }).write(cassette("NEW"));
    expect((await fs.lstat(entry())).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fs.readFile(shared, "utf8")).response.body).toBe("NEW");
    expect((await new CassetteStore({ dir: fixtures }).read(HASH))?.response).toMatchObject({ body: "NEW" });
  });

  it("follows a relative link and a two-hop chain", async () => {
    await fs.mkdir(path.join(root, "shared"));
    await fs.writeFile(path.join(root, "shared", "c.json"), "OLD\n");
    await fs.symlink("c.json", path.join(root, "shared", "hop.json"));
    await fs.symlink(path.join("..", "shared", "hop.json"), entry());
    await new CassetteStore({ dir: fixtures }).write(cassette("NEW"));
    expect((await fs.lstat(entry())).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(root, "shared", "hop.json"))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(root, "shared", "c.json"), "utf8")).response.body).toBe("NEW");
  });

  it("a dangling link creates the file it names", async () => {
    const target = path.join(root, "made.json");
    await fs.symlink(target, entry());
    await new CassetteStore({ dir: fixtures }).write(cassette("NEW"));
    expect((await fs.lstat(entry())).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fs.readFile(target, "utf8")).response.body).toBe("NEW");
  });

  it("a link loop rejects with ELOOP instead of spinning", async () => {
    await fs.symlink(path.join(fixtures, "b"), entry());
    await fs.symlink(entry(), path.join(fixtures, "b"));
    await expect(new CassetteStore({ dir: fixtures }).write(cassette("NEW"))).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("keeps the linked file's mode", async () => {
    const shared = path.join(root, "shared.json");
    await fs.writeFile(shared, "OLD\n");
    await fs.chmod(shared, 0o640);
    await fs.symlink(shared, entry());
    await new CassetteStore({ dir: fixtures }).write(cassette("NEW"));
    expect((await fs.stat(shared)).mode & 0o777).toBe(0o640);
  });

  it("a plain path is written as before", async () => {
    await new CassetteStore({ dir: fixtures }).write(cassette("NEW"));
    expect((await fs.lstat(entry())).isFile()).toBe(true);
    expect(await fs.readdir(fixtures)).toEqual([`${HASH}.json`]);
  });
});
