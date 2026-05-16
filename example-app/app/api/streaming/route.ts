import Anthropic from "@anthropic-ai/sdk";

/**
 * Streaming text generation endpoint.
 *
 * POST { prompt: string }
 * Returns: text/event-stream where each frame is `data: <chunk>\n\n`
 * and the terminal frame is `event: done\ndata: {ms: <int>}\n\n`.
 *
 * The route opens an Anthropic streaming completion and forwards each
 * `text_delta` event as one SSE frame. The cassette layer intercepts the
 * underlying `fetch` so tests can replay deterministic streams.
 */
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { prompt?: unknown };
  try {
    body = (await req.json()) as { prompt?: unknown };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.prompt !== "string" || body.prompt.length === 0) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }
  const prompt = body.prompt;

  const apiKey = process.env.ANTHROPIC_API_KEY ?? "test-key";
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
        for await (const event of responseStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const text = event.delta.text;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
          }
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
