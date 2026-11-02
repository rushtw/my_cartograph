import { ingestPath, inspectPath, IngestError } from "@/lib/ingest/run";
import type { Stage } from "@/lib/ingest/stages";

export const runtime = "nodejs";

// The request names a path on this machine; nothing is uploaded. The answer is
// a stream of JSON lines, one per stage change, so the page shows the stage as
// it happens rather than polling.
export type IngestEvent =
  | { type: "stage"; stage: Stage; message: string }
  | { type: "done"; id: string; alreadyStored: boolean }
  | { type: "error"; stage: Stage; message: string };

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const given = typeof body === "object" && body !== null ? Reflect.get(body, "path") : undefined;
  if (typeof given !== "string") return Response.json({ error: "No path was sent" }, { status: 400 });

  // A path that is missing or isn't a zip or folder is refused before anything starts.
  let source;
  try {
    source = await inspectPath(given);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: IngestEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const outcome = await ingestPath(source, (stage, message) => send({ type: "stage", stage, message }));
        send({ type: "done", ...outcome });
      } catch (error) {
        console.error("Loading a project failed:", error);
        send({
          type: "error",
          stage: error instanceof IngestError ? error.stage : "select",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
