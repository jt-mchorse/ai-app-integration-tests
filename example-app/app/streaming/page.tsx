"use client";

import Link from "next/link";
import { useState } from "react";

type Phase = "idle" | "loading" | "first-token" | "streaming" | "done" | "error";

export default function StreamingPage() {
  const [prompt, setPrompt] = useState("Write a one-sentence haiku about server-side rendering.");
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [ms, setMs] = useState<number | null>(null);

  async function run() {
    setText("");
    setErrorMessage(null);
    setMs(null);
    setPhase("loading");

    let resp: Response;
    try {
      resp = await fetch("/api/streaming", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
    } catch (err) {
      setPhase("error");
      setErrorMessage((err as Error).message);
      return;
    }
    if (!resp.ok || !resp.body) {
      setPhase("error");
      setErrorMessage(`HTTP ${resp.status}`);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let firstSeen = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseFrame(frame);
        if (!parsed) continue;
        if (parsed.kind === "data" && typeof parsed.data.text === "string") {
          if (!firstSeen) {
            firstSeen = true;
            setPhase("first-token");
          } else {
            setPhase("streaming");
          }
          setText((prev) => prev + parsed.data.text);
        } else if (parsed.kind === "done") {
          setPhase("done");
          if (typeof parsed.data.ms === "number") setMs(parsed.data.ms);
        } else if (parsed.kind === "error") {
          setPhase("error");
          setErrorMessage(typeof parsed.data.message === "string" ? parsed.data.message : "unknown");
        }
      }
    }
  }

  return (
    <>
      <div className="nav">
        <Link href="/">← home</Link>
        <Link href="/streaming">streaming</Link>
        <Link href="/tools">tools</Link>
        <Link href="/error">error</Link>
      </div>
      <h1>Streaming text generation</h1>
      <p className="muted">
        The route emits SSE frames; the client renders tokens as they arrive. Inspect
        the phase indicator below — it transitions <code>loading → first-token →
        streaming → done</code> exactly once per run, deterministically under replay.
      </p>
      <div className="card">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          aria-label="prompt"
          data-testid="prompt-input"
        />
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={run} disabled={phase === "loading" || phase === "streaming"} data-testid="run-button">
            Run
          </button>
          <span className="muted" data-testid="phase-indicator">phase: {phase}</span>
          {ms !== null ? <span className="muted">· {ms} ms</span> : null}
        </div>
      </div>
      {errorMessage ? (
        <div className="card error-card" data-testid="error-card">
          <strong>Error.</strong> {errorMessage}
        </div>
      ) : null}
      <div className="card answer" data-testid="answer">{text}</div>
    </>
  );
}

function parseFrame(frame: string):
  | { kind: "data"; data: Record<string, unknown> }
  | { kind: "done"; data: Record<string, unknown> }
  | { kind: "error"; data: Record<string, unknown> }
  | null {
  let event = "message";
  let dataLine = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) dataLine += line.slice(6);
  }
  if (!dataLine) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataLine) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event === "done") return { kind: "done", data };
  if (event === "error") return { kind: "error", data };
  return { kind: "data", data };
}
