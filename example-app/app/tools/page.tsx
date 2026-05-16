"use client";

import Link from "next/link";
import { useState } from "react";

interface ToolCall {
  name: string;
  input: unknown;
  result: unknown;
}

interface ToolResponse {
  toolCalls: ToolCall[];
  finalText: string;
}

export default function ToolsPage() {
  const [query, setQuery] = useState("What's 17 * 23?");
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<ToolResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResponse(null);
    try {
      const resp = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(typeof data.error === "string" ? data.error : `HTTP ${resp.status}`);
      } else {
        setResponse(data as ToolResponse);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
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
      <h1>Tool use</h1>
      <p className="muted">
        Two tools available: <code>get_weather</code> and <code>calculate</code>.
        The model picks one, the route executes it, and the final answer comes
        back. Tests assert the tool routing and the final-text format.
      </p>
      <div className="card">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="query"
          data-testid="query-input"
        />
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={run} disabled={busy} data-testid="run-button">
            Run
          </button>
          <span className="muted" data-testid="phase-indicator">
            phase: {busy ? "loading" : response ? "done" : error ? "error" : "idle"}
          </span>
        </div>
      </div>
      {error ? (
        <div className="card error-card" data-testid="error-card">
          <strong>Error.</strong> {error}
        </div>
      ) : null}
      {response ? (
        <>
          {response.toolCalls.length > 0 ? (
            <>
              <h2>Tool calls</h2>
              {response.toolCalls.map((tc, i) => (
                <div key={i} className="tool-call" data-testid={`tool-call-${i}`}>
                  <strong>{tc.name}</strong>({JSON.stringify(tc.input)}){"\n"}
                  → {JSON.stringify(tc.result)}
                </div>
              ))}
            </>
          ) : null}
          {response.finalText ? (
            <>
              <h2>Answer</h2>
              <div className="card answer" data-testid="final-text">{response.finalText}</div>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
