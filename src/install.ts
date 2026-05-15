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
