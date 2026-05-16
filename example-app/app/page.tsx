import Link from "next/link";

export default function HomePage() {
  return (
    <>
      <h1>ai-app-integration-tests · example app</h1>
      <p className="muted">
        Three LLM-driven screens that exercise the patterns this repo's toolkit tests:
        streaming SSE, tool use, and a deliberate error path. Each screen has a
        client component that calls a Next.js route handler, which calls Anthropic.
        Tests intercept the Anthropic HTTP calls via the cassette layer.
      </p>
      <h2>Screens</h2>
      <div className="card">
        <h2 style={{ margin: 0 }}><Link href="/streaming">/streaming</Link></h2>
        <div className="muted">
          Streaming text generation. The route emits SSE; the client renders tokens
          as they arrive. Test surface: loading → first-token → completed states.
        </div>
      </div>
      <div className="card">
        <h2 style={{ margin: 0 }}><Link href="/tools">/tools</Link></h2>
        <div className="muted">
          Tool use. The model picks one of two tools (<code>get_weather</code> or{" "}
          <code>calculate</code>), the UI renders the tool call and result, then
          the final answer. Test surface: deterministic tool-routing assertions.
        </div>
      </div>
      <div className="card">
        <h2 style={{ margin: 0 }}><Link href="/error">/error</Link></h2>
        <div className="muted">
          Error path. The route forces an unparseable response shape; the UI
          surfaces a structured error card instead of crashing. Test surface:
          the "what does the UI do when the model misbehaves" question.
        </div>
      </div>
    </>
  );
}
