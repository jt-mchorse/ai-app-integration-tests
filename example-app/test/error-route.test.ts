/**
 * Test the /api/error route handler in-process.
 *
 * No Next.js server is started; the route handler is just an exported
 * function we call with a `Request`. The `validation` and `shape` paths
 * don't hit Anthropic at all so they need no cassette. The `upstream`
 * path would hit Anthropic for real, so it's exercised by the toolkit's
 * tests (root-level), not here — keeping example-app tests dep-light.
 */

import { describe, expect, it } from "vitest";
import { POST } from "../app/api/error/route.js";

describe("/api/error", () => {
  it("validation kind returns 400 with structured envelope", async () => {
    const req = new Request("http://localhost/api/error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "validation", prompt: "anything" }),
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as {
      error: string;
      message: string;
      details: { received: string };
    };
    expect(body.error).toBe("validation");
    expect(body.message).toMatch(/failed validation/i);
    expect(body.details.received).toBe("anything");
  });

  it("shape kind returns 502 with structured envelope (no upstream call)", async () => {
    const req = new Request("http://localhost/api/error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "shape" }),
    });
    const resp = await POST(req);
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: string; message: string };
    expect(body.error).toBe("shape");
    expect(body.message).toMatch(/no text or tool_use blocks/i);
  });

  it("rejects unknown kind", async () => {
    const req = new Request("http://localhost/api/error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "banana" }),
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string; message: string };
    expect(body.error).toBe("validation");
    expect(body.message).toMatch(/kind must be/);
  });

  it("rejects invalid JSON body", async () => {
    const req = new Request("http://localhost/api/error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
  });
});
