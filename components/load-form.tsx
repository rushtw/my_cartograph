"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { IngestEvent } from "@/app/api/projects/route";
import { STAGES, type Stage } from "@/lib/ingest/stages";
import { StateMark } from "./state-mark";

type Run =
  | { phase: "idle" }
  | { phase: "uploading"; percent: number }
  | { phase: "running"; stage: Stage; message: string }
  | { phase: "failed"; stage: Stage | "upload"; message: string };

// Sends the chosen zip as the request body and follows the stage lines the
// server streams back. Nothing polls: the stage is shown when it is sent.
export function LoadForm() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const busy = run.phase === "uploading" || run.phase === "running";

  function start() {
    if (!file || busy) return;
    const request = new XMLHttpRequest();
    request.open("POST", `/api/projects?name=${encodeURIComponent(file.name)}`);
    setRun({ phase: "uploading", percent: 0 });

    request.upload.onprogress = (e) => {
      if (e.lengthComputable) setRun({ phase: "uploading", percent: Math.round((e.loaded / e.total) * 100) });
    };

    // Lines arrive as the server sends them; read only what's new each time.
    let read = 0;
    let outcome: Extract<IngestEvent, { type: "done" | "error" }> | null = null;
    const consume = () => {
      const text = request.responseText;
      const end = text.lastIndexOf("\n") + 1;
      for (const line of text.slice(read, end).split("\n")) {
        if (!line) continue;
        const event = JSON.parse(line) as IngestEvent;
        if (event.type === "stage") setRun({ phase: "running", stage: event.stage, message: event.message });
        else outcome = event;
      }
      read = end;
    };
    request.onprogress = consume;
    request.onerror = () => setRun({ phase: "failed", stage: "upload", message: "The upload failed. Is the dev server still running?" });
    request.onload = () => {
      if (request.status !== 200) {
        let message = `The server answered ${request.status}`;
        try {
          message = (JSON.parse(request.responseText) as { error: string }).error;
        } catch {}
        setRun({ phase: "failed", stage: "upload", message });
        return;
      }
      consume();
      const final: IngestEvent | null = outcome;
      if (final?.type === "done") router.push(`/projects/${final.id}`);
      else if (final?.type === "error") setRun({ phase: "failed", stage: final.stage, message: final.message });
      else setRun({ phase: "failed", stage: "upload", message: "The server stopped before finishing" });
    };
    request.send(file);
  }

  const current = run.phase === "running" ? STAGES.findIndex((s) => s.stage === run.stage) : -1;
  return (
    <section>
      <h2 className="text-[11px] text-fg-muted">Load a project</h2>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setRun({ phase: "idle" });
          }}
          className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-xs file:mr-2 file:border-0 file:bg-transparent file:text-xs file:text-fg-muted"
        />
        <button
          type="button"
          onClick={start}
          disabled={!file || busy}
          className="h-7 shrink-0 rounded bg-accent px-3 text-xs text-accent-fg disabled:opacity-40"
        >
          Analyse
        </button>
      </div>
      <p className="mt-1 text-[11px] text-fg-muted">A zip of a TypeScript or JavaScript project. Dependencies and dot-folders are left out; nothing leaves this machine.</p>

      {run.phase !== "idle" && (
        <ol className="mt-3 text-xs">
          <li className="grid grid-cols-[1rem_7rem_minmax(0,1fr)] items-baseline gap-x-2 py-0.5">
            <StateMark status={run.phase === "uploading" ? "running" : run.phase === "failed" && run.stage === "upload" ? "failed" : "complete"} />
            <span>Upload</span>
            <span className="text-fg-muted">
              {run.phase === "uploading" ? `${run.percent}%` : run.phase === "failed" && run.stage === "upload" ? run.message : "done"}
            </span>
          </li>
          {STAGES.map(({ stage, label }, i) => {
            const failedHere = run.phase === "failed" && run.stage === stage;
            const state = failedHere ? "failed" : run.phase === "running" && i === current ? "running" : (run.phase === "running" && i < current) || (run.phase === "failed" && run.stage !== "upload" && i < STAGES.findIndex((s) => s.stage === run.stage)) ? "complete" : "queued";
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
