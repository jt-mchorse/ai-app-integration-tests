import Anthropic from "@anthropic-ai/sdk";

/**
 * Error-path endpoint.
 *
 * POST { kind: "validation" | "upstream" | "shape" }
 * Returns: structured JSON describing the failure mode the UI should render.
 *
 * - `validation` — the request body fails our own schema. Returns 400.
 * - `upstream` — we attempt an Anthropic call that returns/throws an error;
 *   the route surfaces the SDK error type and message. Returns 502.
 * - `shape` — the upstream "succeeds" but the response has no usable text
 *   blocks. The route catches this and returns a structured "unparseable"
 *   payload instead of letting it bubble. Returns 502.
 *
 * Together these cover the three failure surfaces a real Next.js LLM app
 * faces: bad input, bad upstream, bad output.
 */
export const runtime = "nodejs";

interface ErrorBody {
  kind: "validation" | "upstream" | "shape";
  prompt?: string;
}

export async function POST(req: Request) {
  let body: Partial<ErrorBody>;
  try {
    body = (await req.json()) as Partial<ErrorBody>;
  } catch {
    return Response.json(
      { error: "validation", message: "invalid JSON body" },
      { status: 400 },
    );
  }

  if (body.kind !== "validation" && body.kind !== "upstream" && body.kind !== "shape") {
    return Response.json(
      { error: "validation", message: 'kind must be one of "validation"|"upstream"|"shape"' },
      { status: 400 },
    );
  }

  if (body.kind === "validation") {
    return Response.json(
      {
        error: "validation",
        message: "(synthetic) the prompt failed validation",
        details: { received: body.prompt ?? null },
      },
      { status: 400 },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY ?? "test-key";
  const client = new Anthropic({ apiKey });

  if (body.kind === "upstream") {
    // Trigger an upstream-shaped error by pointing at a deliberately invalid
    // model id. Anthropic SDK throws an APIError; the route catches it and
    // returns a structured payload the UI can render.
    try {
      await client.messages.create({
        model: "claude-no-such-model",
        max_tokens: 8,
        messages: [{ role: "user", content: body.prompt ?? "hello" }],
      });
      return Response.json({ error: "upstream", message: "expected an upstream error" }, { status: 502 });
    } catch (err) {
      const e = err as { name?: string; status?: number; message?: string };
      return Response.json(
        {
          error: "upstream",
          message: e.message ?? "upstream error",
          status: e.status ?? null,
          type: e.name ?? "Error",
        },
        { status: 502 },
      );
    }
  }

  // kind === "shape" — the upstream "succeeds" but we treat the response as
  // unparseable. We don't even bother calling the SDK here; we hand-craft
  // the failure so tests don't need an upstream that returns a malformed
  // block list. (Cassette-replayed runs would catch the real surface too.)
  return Response.json(
    {
      error: "shape",
      message: "(synthetic) the model returned a response with no text or tool_use blocks",
    },
    { status: 502 },
  );
}
