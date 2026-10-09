import Anthropic from "@anthropic-ai/sdk";

import { readApiKey } from "../../../api-key";

/**
 * Streaming text generation endpoint.
 *
 * POST { prompt: string }
 * Returns: text/event-stream where each frame is `data: <chunk>\n\n`
 * and the terminal frame is `event: done\ndata: {ms: <int>}\n\n` when the
 * model finished, or `event: error\ndata: {message}\n\n` when it did not:
 * cut at `max_tokens`, refused, or an upstream body that ended before
 * `message_stop` (#177).
 *
 * The route opens an Anthropic streaming completion and forwards each
 * `text_delta` event as one SSE frame. The cassette layer intercepts the
 * underlying `fetch` so tests can replay deterministic streams.
 */
export const runtime = "nodejs";

export async function POST(req: Request) {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // Valid JSON is not necessarily an object (#135): `null` passed the parse
  // and then threw on the field read below -- a TypeError 500 -- while an
  // array, string or number was refused only because its property is undefined.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Response.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const body = parsed as { prompt?: unknown };
  if (typeof body.prompt !== "string" || body.prompt.length === 0) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }
  const prompt = body.prompt;

  const apiKey = readApiKey();
  const client = new Anthropic({ apiKey });

  const t0 = Date.now();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const responseStream = await client.messages.stream({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 256,
          messages: [{ role: "user", content: prompt }],
        });
        // How the upstream says the answer ended (#177). `event: done` went out
        // whatever happened, so an answer cut at max_tokens -- 256, with any
        // prompt the caller posts -- or a body that simply ended was reported
        // as finished. A throw lands in the catch below as `event: error`.
        let stopReason: string | null = null;
        let sawMessageStop = false;
        for await (const event of responseStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const text = event.delta.text;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
          } else if (event.type === "message_delta") {
            stopReason = event.delta.stop_reason ?? stopReason;
          } else if (event.type === "message_stop") {
            sawMessageStop = true;
          }
        }
        if (!sawMessageStop) {
          throw new Error("the upstream stream ended before message_stop; the answer is incomplete");
        }
        if (stopReason !== "end_turn" && stopReason !== "stop_sequence") {
          throw new Error(`the model stopped with stop_reason=${String(stopReason)}; the answer is incomplete`);
        }
        controller.enqueue(
          encoder.encode(`event: done\ndata: ${JSON.stringify({ ms: Date.now() - t0 })}\n\n`),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
