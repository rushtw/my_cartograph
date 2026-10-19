import { createHash } from "node:crypto";
import { generateText, Output } from "ai";
import { z } from "zod";
import { MODEL_ROLES, type ModelRole } from "../roles.ts";
import { model, MODEL, PROVIDER_OPTIONS } from "./client.ts";
import {
  CLASSIFY_SYSTEM,
  classifyMessage,
  EXPLAIN_FILE_SYSTEM,
  EXPLAIN_FOLDER_SYSTEM,
  explainFileMessage,
  explainFolderMessage,
  PROMPT_VERSION,
  type ClassifyInput,
  type FileInput,
  type FolderInput,
} from "./prompts.ts";

// The model calls, each behind its cache. A hit is reported as cached, so a
// working cache is visible to the person clicking and a broken one is too.

export type Task = "explain-file" | "explain-folder" | "classify-file";

export type Cache = {
  read: (key: string) => Promise<string | null>;
  write: (key: string, body: string) => Promise<void>;
};

export type Explanation = { body: string; model: string; cached: boolean };

// The source is only read on a miss: a hit answers from the stored hash alone.
export type SourceOf = () => Promise<string>;

// The largest file the parser reads is well under this; it's a backstop
// against an unexpectedly huge prompt, and the model is told when it applies.
const MAX_SOURCE_CHARS = 120_000;
const EXCERPT_LINES = 60;

export function cacheKey(task: Task, input: unknown): string {
  return createHash("sha256").update(JSON.stringify({ task, version: PROMPT_VERSION, model: MODEL, input })).digest("hex");
}

export async function explainFile(input: FileInput, deps: { cache: Cache; source: SourceOf }): Promise<Explanation> {
  const key = cacheKey("explain-file", input);
  const hit = await deps.cache.read(key);
  if (hit !== null) return { body: hit, model: MODEL, cached: true };
  const body = await complete(EXPLAIN_FILE_SYSTEM, explainFileMessage(input, capped(await deps.source())));
  await deps.cache.write(key, body);
  return { body, model: MODEL, cached: false };
}

export async function explainFolder(input: FolderInput, deps: { cache: Cache }): Promise<Explanation> {
  const key = cacheKey("explain-folder", input);
  const hit = await deps.cache.read(key);
  if (hit !== null) return { body: hit, model: MODEL, cached: true };
  const body = await complete(EXPLAIN_FOLDER_SYSTEM, explainFolderMessage(input));
  await deps.cache.write(key, body);
  return { body, model: MODEL, cached: false };
}

// "none" is a real answer, and cached like any other: the model isn't made to
// pick something when nothing fits, and the file stays unclassified.
const NONE = "none";
const roleSchema = z.object({ role: z.enum([...MODEL_ROLES, NONE]) });

export async function classifyFile(input: ClassifyInput, deps: { cache: Cache; source: SourceOf }): Promise<{ role: ModelRole | null; cached: boolean }> {
  const key = cacheKey("classify-file", input);
  const hit = await deps.cache.read(key);
  if (hit !== null) return { role: parseRole(hit), cached: true };
  const excerpt = (await deps.source()).split("\n").slice(0, EXCERPT_LINES).join("\n");
  const { output } = await generateText({
    model: model(),
    providerOptions: PROVIDER_OPTIONS,
    output: Output.object({ schema: roleSchema }),
    system: CLASSIFY_SYSTEM,
    prompt: classifyMessage(input, excerpt),
  });
  // Parsed before caching, so a refused answer is never stored and served.
  const role = parseRole(output.role);
  await deps.cache.write(key, output.role);
  return { role, cached: false };
}

function parseRole(answer: string): ModelRole | null {
  if (answer === NONE) return null;
  // Structural roles aren't in the schema, but the answer is checked rather
  // than trusted: convention alone decides what's routable.
  const role = MODEL_ROLES.find((r) => r === answer);
  if (!role) throw new Error(`The model answered the role "${answer}", which it isn't allowed to give`);
  return role;
}

async function complete(system: string, prompt: string): Promise<string> {
  const { text, finishReason } = await generateText({ model: model(), providerOptions: PROVIDER_OPTIONS, system, prompt });
  const body = text.trim();
  if (!body) throw new Error(`${MODEL} returned an empty answer (finish reason: ${finishReason})`);
  return body;
}

function capped(source: string): string {
  if (source.length <= MAX_SOURCE_CHARS) return source;
  return `${source.slice(0, MAX_SOURCE_CHARS)}\n[… source truncated here: ${source.length - MAX_SOURCE_CHARS} more characters not shown]`;
}
