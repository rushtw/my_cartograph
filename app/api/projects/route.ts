import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { incomingName, ingestZip, IngestError } from "@/lib/ingest/run";
import type { Stage } from "@/lib/ingest/stages";
import { DATA_DIR } from "@/lib/store/projects";

export const runtime = "nodejs";

// The zip is the request body, sent as-is (not a form), so it streams to disk
// without being held in memory. The answer is a stream of JSON lines, one per
// stage change, so the page shows the stage as it happens rather than polling.
export type IngestEvent =
  | { type: "stage"; stage: Stage; message: string }
  | { type: "done"; id: string; alreadyStored: boolean }
  | { type: "error"; stage: Stage | "upload"; message: string };

// Stated rather than engineered round: there is no queue or worker.
const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;

export async function POST(request: Request): Promise<Response> {
  const name = cleanName(new URL(request.url).searchParams.get("name"));
  if (!request.body) return Response.json({ error: "No file was sent" }, { status: 400 });

  await mkdir(DATA_DIR, { recursive: true });
  const zipPath = path.join(DATA_DIR, incomingName());
  try {
    await saveBody(request.body, zipPath);
  } catch (error) {
    await rm(zipPath, { force: true });
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: IngestEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const outcome = await ingestZip(zipPath, name, (stage, message) => send({ type: "stage", stage, message }));
        send({ type: "done", ...outcome });
      } catch (error) {
        console.error("Loading a project failed:", error);
        send({
          type: "error",
          stage: error instanceof IngestError ? error.stage : "extract",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Stored projects had the zip moved away; anything left is unused.
        await rm(zipPath, { force: true });
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}

async function saveBody(body: ReadableStream<Uint8Array>, destination: string): Promise<void> {
  const file = await open(destination, "wx");
  const reader = body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_UPLOAD_BYTES) throw new Error(`That file is over ${MAX_UPLOAD_BYTES / 1024 ** 3} GB, the most this can load`);
      await file.write(value);
    }
  } finally {
    reader.releaseLock();
    await file.close();
  }
  if (received === 0) throw new Error("The file was empty");
}

// The name is only a label for the list; it never touches a path.
function cleanName(raw: string | null): string {
  const base = (raw ?? "").replace(/\.zip$/i, "").replace(/[^\p{L}\p{N}._ -]/gu, "").trim().slice(0, 80);
  return base || "project";
}
