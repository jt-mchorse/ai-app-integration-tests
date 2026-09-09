/**
 * One definition of "where this repo's source lives", shared by the test-side
 * structural locks (#117).
 *
 * Two locks needed this and had two answers. `architecture-doc.test.ts` walked
 * `src` recursively; `proto-key-accumulators.test.ts` — shipped one session
 * earlier — used `readdirSync(SRC_DIR).filter(f => f.endsWith(".ts"))`, which
 * returns one level. `src/support/` exists, so it was invisible.
 *
 * Measured, the same accumulator planted twice:
 *
 *     export function probeCollect(pairs) {
 *       const out: Record<string, string> = {};
 *       for (const [k, v] of pairs) out[k.toLowerCase()] = v;
 *       return out;
 *     }
 *
 *     planted at src/support/_probe.ts   ->  10 passed (10)     invisible
 *     planted at src/_probe.ts           ->  1 failed | 9 passed
 *
 * Identical hazard, identical shape; one directory level apart.
 *
 * That matters more than usual here, because the lock in question exists
 * precisely to stop a rule being scoped smaller than the hazard it describes —
 * its docstring recounts three prior scopings (#57/#70 body encoding, #75 body
 * keys, #115 headers) and says the population is "discovered rather than
 * listed". It discovered accumulators *within* a file and hand-scoped the set
 * of files.
 *
 * A shared definition rather than a second correct copy: two locks whose
 * populations can quietly disagree is the same shape one level up from the
 * thing they are checking.
 *
 * Deliberately test-side. Nothing in `src/` needs to enumerate the repo's own
 * files, and putting it there would widen the package's public surface.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(__dirname, "..", "..");

/** Every directory holding first-party source. */
export const SOURCE_DIRS = ["src"] as const;

export const SOURCE_EXTS = [".ts", ".tsx"] as const;

/**
 * Every source file under *dir*, recursively, as an absolute path.
 *
 * Recursive on purpose. `readdirSync(base)` returns one level, so a
 * subdirectory drops out of a caller's population with no error and no
 * warning — just a smaller set, which reads exactly like a clean scan.
 *
 * `node_modules` and dotfiles are skipped, as the original recursive walk in
 * `architecture-doc.test.ts` did; this is that function, lifted rather than
 * rewritten, so sharing it is a no-op for its first caller.
 */
export function sourceFiles(dir: string, root: string = ROOT): string[] {
  const abs = resolve(root, dir);
  if (!existsSync(abs)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(abs, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(join(dir, entry.name), root));
    else if (SOURCE_EXTS.some((e) => entry.name.endsWith(e))) files.push(full);
  }
  return files;
}

/** Every source file across every `SOURCE_DIRS` entry, absolute paths. */
export function allSourceFiles(root: string = ROOT): string[] {
  return SOURCE_DIRS.flatMap((d) => sourceFiles(d, root)).sort();
}
