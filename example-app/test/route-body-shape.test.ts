/**
 * Every API route answers a non-object JSON body with its own 400 (#135).
 *
 * `null` is valid JSON, so it passed each route's `req.json()` try/catch and
 * then threw on the field read -- `Cannot read properties of null (reading
 * 'prompt' | 'query' | 'kind')`, a 500 under Next. An array, string, number or
 * boolean was refused only because reading a property off it gives
 * `undefined`, so the 400 named a missing field rather than the actual shape.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { POST as errorPOST } from "../app/api/error/route.js";
import { POST as streamingPOST } from "../app/api/streaming/route.js";
import { POST as toolsPOST } from "../app/api/tools/route.js";

const ROUTES = [
  ["streaming", streamingPOST, { error: "body must be a JSON object" }],
  ["tools", toolsPOST, { error: "body must be a JSON object" }],
  ["error", errorPOST, { error: "validation", message: "body must be a JSON object" }],
] as const;

function rawRequest(route: string, body: string): Request {
  return new Request(`http://localhost/api/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe.each(ROUTES)("POST /api/%s — body shape", (route, post, envelope) => {
  it.each(["null", "[]", '[{"prompt":"x","query":"x","kind":"validation"}]', '"x"', "42", "true"])(
    "refuses %s with the route's own 400",
    async (raw) => {
      const res = await post(rawRequest(route, raw));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(envelope);
    },
  );

  it("still names the missing field for an empty object", async () => {
    const res = await post(rawRequest(route, "{}"));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("JSON object");
  });
});

describe("every API route that parses a JSON body guards its shape", () => {
  const apiDir = resolve(__dirname, "..", "app", "api");
  const routes = readdirSync(apiDir)
    .map((name) => join(apiDir, name, "route.ts"))
    .filter((p) => {
      try {
        return /\breq\.json\(\)/.test(readFileSync(p, "utf8"));
      } catch {
        return false;
      }
    });

  it("finds the routes (non-zero control)", () => {
    expect(routes).toHaveLength(ROUTES.length);
  });

  it.each(routes)("%s refuses null and non-objects before reading a field", (p) => {
    expect(readFileSync(p, "utf8")).toMatch(
      /=== null \|\| typeof \w+ !== "object" \|\| Array\.isArray\(\w+\)/,
    );
  });
});
