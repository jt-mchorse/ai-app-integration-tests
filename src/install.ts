import { createRecorderFetch, createReplayerFetch } from "./fetch-recorder.js";
import { CassetteStore } from "./io.js";

export interface InstallOptions {
  /** Directory the cassettes live in. Default: `./fixtures`. */
  fixturesDir?: string;
  /**
   * Hostnames to intercept. Default: ["api.anthropic.com"]. Add others
   * (e.g., "api.openai.com") explicitly when you want them captured.
   */
  hosts?: string[];
}

const DEFAULT_HOSTS = ["api.anthropic.com"];

/**
 * Validate `opts.hosts` at the install-function entry (#26).
 *
 * Same harm class as D-005 (`missing-cassette-is-fatal`) but at the
 * layer above: `installRecorder({ hosts: [] })` silently degraded to
 * pass-through because `?? DEFAULT_HOSTS` only handles `undefined`,
 * not empty arrays. Every "intercepted" call then hit the real upstream
 * — tests pass green but were actually hitting live APIs.
 */
function validateHosts(hosts: string[] | undefined, fnName: string): void {
  if (hosts === undefined) return; // default DEFAULT_HOSTS applies
  if (hosts.length === 0) {
    throw new Error(
      `${fnName}: hosts must be a non-empty array; got []. Pass at least one hostname or omit the field to use the default ["api.anthropic.com"].`,
    );
  }
  for (const [i, h] of hosts.entries()) {
    if (typeof h !== "string" || h.length === 0) {
      throw new Error(
        `${fnName}: hosts[${i}] must be a non-empty string; got ${JSON.stringify(h)}`,
      );
    }
  }
}

let originalFetch: typeof fetch | null = null;

/**
 * Replace global `fetch` with a recorder. Subsequent intercepted calls hit the
 * upstream and write a cassette per request to `fixturesDir`.
 *
 * Test setup pattern:
 *
 * ```ts
 * import { afterAll, beforeAll } from "vitest";
 * import { installRecorder, uninstall } from "ai-app-integration-tests";
 *
 * beforeAll(() => installRecorder({ fixturesDir: "./fixtures" }));
 * afterAll(() => uninstall());
 * ```
 */
export function installRecorder(opts: InstallOptions = {}): void {
  validateHosts(opts.hosts, "installRecorder");
  if (originalFetch !== null) {
    throw new Error("an interceptor is already installed; call uninstall() first");
  }
  originalFetch = globalThis.fetch;
  globalThis.fetch = createRecorderFetch({
    upstream: originalFetch,
    store: new CassetteStore({ dir: opts.fixturesDir ?? "./fixtures" }),
    hosts: new Set(opts.hosts ?? DEFAULT_HOSTS),
  });
}

/**
 * Replace global `fetch` with a replayer. Intercepted calls look up the cassette
 * by request hash; missing cassette throws.
 */
export function installReplayer(opts: InstallOptions = {}): void {
  validateHosts(opts.hosts, "installReplayer");
  if (originalFetch !== null) {
    throw new Error("an interceptor is already installed; call uninstall() first");
  }
  originalFetch = globalThis.fetch;
  globalThis.fetch = createReplayerFetch({
    store: new CassetteStore({ dir: opts.fixturesDir ?? "./fixtures" }),
    hosts: new Set(opts.hosts ?? DEFAULT_HOSTS),
  });
}

export function uninstall(): void {
  if (originalFetch === null) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
}

/**
 * Install the recorder when ANTHROPIC_TEST_MODE=record, the replayer when
 * "replay" (default), and pass-through when "live".
 */
export function installFromEnv(opts: InstallOptions = {}): void {
  const mode = (process.env.ANTHROPIC_TEST_MODE ?? "replay").toLowerCase();
  switch (mode) {
    case "record":
      installRecorder(opts);
      return;
    case "replay":
      installReplayer(opts);
      return;
    case "live":
      // Pass-through: do nothing. Tests calling the real API.
      return;
    default:
      throw new Error(
        `ANTHROPIC_TEST_MODE must be "record" | "replay" | "live"; got ${JSON.stringify(mode)}`,
      );
  }
}
