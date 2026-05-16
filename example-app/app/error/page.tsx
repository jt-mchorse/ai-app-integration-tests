"use client";

import Link from "next/link";
import { useState } from "react";

type Kind = "validation" | "upstream" | "shape";

interface ErrorPayload {
  error: string;
  message: string;
  status?: number | null;
  type?: string;
  details?: unknown;
}

export default function ErrorPage() {
  const [kind, setKind] = useState<Kind>("validation");
  const [busy, setBusy] = useState(false);
  const [payload, setPayload] = useState<ErrorPayload | null>(null);

  async function run() {
    setBusy(true);
    setPayload(null);
    try {
      const resp = await fetch("/api/error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, prompt: "synthetic" }),
      });
      const data = (await resp.json()) as ErrorPayload;
      setPayload(data);
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
      <h1>Error path</h1>
      <p className="muted">
        Three failure modes a real LLM app faces: bad input, bad upstream, bad
        output. Each returns a structured error envelope the UI renders below
        — the UI doesn't crash and doesn't pretend the call succeeded.
      </p>
      <div className="card">
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <label>
            <input
              type="radio"
              name="kind"
              value="validation"
              checked={kind === "validation"}
              onChange={() => setKind("validation")}
              data-testid="kind-validation"
            />{" "}
            validation
          </label>
          <label>
            <input
              type="radio"
              name="kind"
              value="upstream"
              checked={kind === "upstream"}
              onChange={() => setKind("upstream")}
              data-testid="kind-upstream"
            />{" "}
            upstream
          </label>
          <label>
            <input
              type="radio"
              name="kind"
              value="shape"
              checked={kind === "shape"}
              onChange={() => setKind("shape")}
              data-testid="kind-shape"
            />{" "}
            shape
          </label>
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={run} disabled={busy} data-testid="run-button">
            Trigger error
          </button>
        </div>
      </div>
      {payload ? (
        <div className="card error-card" data-testid="error-card">
          <strong>{payload.error}.</strong> {payload.message}
          {payload.type ? <div className="muted">type: {payload.type}</div> : null}
          {typeof payload.status === "number" ? (
            <div className="muted">status: {payload.status}</div>
          ) : null}
          {payload.details ? (
            <pre className="muted" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
              {JSON.stringify(payload.details, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
