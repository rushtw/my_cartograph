"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IngestEvent } from "@/app/api/projects/route";
import { STAGES, type Stage } from "@/lib/ingest/stages";
import { StateMark } from "./state-mark";

type Run =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; stage: Stage; message: string }
  | { phase: "failed"; stage: Stage | "path"; message: string };

// Explorer's "Copy as path" adds quotes; the server strips them too, this only
// decides which stages to show before the server has said anything.
const isZip = (typed: string) => /\.zip"?\s*$/i.test(typed);

// Sends the typed path and follows the stage lines the server streams back.
// Nothing is uploaded and nothing polls: the stage is shown when it is sent.
export function LoadForm() {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const busy = run.phase === "starting" || run.phase === "running";
  // A folder has nothing to unpack, so its list has no Unpack row.
  const stages = isZip(typed) ? STAGES : STAGES.filter((s) => s.stage !== "extract");

  async function start() {
    if (!typed.trim() || busy) return;
    setRun({ phase: "starting" });
    let response: Response;
    try {
      response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: typed }) });
    } catch {
      setRun({ phase: "failed", stage: "path", message: "Could not reach the server. Is the dev server still running?" });
      return;
    }
    if (!response.ok || !response.body) {
      let message = `The server answered ${response.status}`;
      try {
        message = ((await response.json()) as { error: string }).error;
      } catch {}
      setRun({ phase: "failed", stage: "path", message });
      return;
    }

    // Lines arrive as the server sends them; a half-arrived line waits for the rest.
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    let outcome: Extract<IngestEvent, { type: "done" | "error" }> | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      const end = pending.lastIndexOf("\n") + 1;
      for (const line of pending.slice(0, end).split("\n")) {
        if (!line) continue;
        const event = JSON.parse(line) as IngestEvent;
        if (event.type === "stage") setRun({ phase: "running", stage: event.stage, message: event.message });
        else outcome = event;
      }
      pending = pending.slice(end);
    }
    if (outcome?.type === "done") router.push(`/projects/${outcome.id}`);
    else if (outcome?.type === "error") setRun({ phase: "failed", stage: outcome.stage, message: outcome.message });
    else setRun({ phase: "failed", stage: "path", message: "The server stopped before finishing" });
  }

  const current = run.phase === "running" ? stages.findIndex((s) => s.stage === run.stage) : -1;
  const failedAt = run.phase === "failed" ? stages.findIndex((s) => s.stage === run.stage) : -1;
  return (
    <section>
      <h2 className="text-[11px] text-fg-muted">Load a project</h2>
      <form
        className="mt-1.5 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <input
          type="text"
          value={typed}
          disabled={busy}
          onChange={(e) => {
            setTyped(e.target.value);
            setRun({ phase: "idle" });
          }}
          placeholder="C:\path\to\project  or  C:\path\to\project.zip"
          spellCheck={false}
          autoComplete="off"
          aria-label="Path to a zip or a folder"
          className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 font-mono text-xs"
        />
        <button type="submit" disabled={!typed.trim() || busy} className="h-7 shrink-0 rounded bg-accent px-3 text-xs text-accent-fg disabled:opacity-40">
          Analyse
        </button>
      </form>
      <p className="mt-1 text-[11px] text-fg-muted">
        Paste a path, or drag a zip or folder from Explorer into the box. A zip or a folder of TypeScript or JavaScript. Dependencies and dot-folders are left out; nothing leaves this machine, and nothing in the folder is changed.
      </p>
      {run.phase === "failed" && run.stage === "path" && <p className="mt-2 text-xs">{run.message}</p>}

      {(run.phase === "running" || (run.phase === "failed" && run.stage !== "path")) && (
        <ol className="mt-3 text-xs">
          {stages.map(({ stage, label }, i) => {
            const failedHere = failedAt === i;
            const reached = run.phase === "running" ? i < current : failedAt !== -1 && i < failedAt;
            const state = failedHere ? "failed" : run.phase === "running" && i === current ? "running" : reached ? "complete" : "queued";
            const detail = failedHere ? run.message : run.phase === "running" && i === current ? run.message : null;
            return (
              <li key={stage} className="grid grid-cols-[1rem_7rem_minmax(0,1fr)] items-baseline gap-x-2 py-0.5">
                <span className={state === "queued" ? "text-line" : "text-fg"}>
                  <StateMark status={state} />
                </span>
                <span className={state === "queued" ? "text-fg-muted" : "text-fg"}>{label}</span>
                <span className={failedHere ? "text-fg" : "text-fg-muted"}>{detail}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
