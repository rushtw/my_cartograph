import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deserializeParseResult } from "../parser/contract.ts";
import type { ParseResult } from "../parser/types.ts";
import { isModelRole, type ModelRole } from "../roles.ts";

// Stored projects are plain files, one folder each. One user on one machine
// needs somewhere to remember results, a list, and a cache; nothing here is
// queried, because the browser holds the whole graph.
//
//   data/<id>/meta.json        what the list shows
//   data/<id>/sources.json     the text of every parsed file, by path (the zip is deleted once loaded)
//   data/<id>/result.json      the parser's output, checked against its contract on every read
//   data/<id>/ai-cache.json    answers by key
//   data/<id>/model-roles.json roles the model gave files no convention identified

export const DATA_DIR = path.join(process.cwd(), "data");

export type ProjectMeta = {
  id: string;
  name: string;
  addedAt: string;
  files: number;
  edges: number;
  routes: number;
  skipped: number;
  unresolved: number;
};

const ID = /^[0-9a-f]{16}$/;

export function isProjectId(value: string): boolean {
  return ID.test(value);
}

function folder(id: string): string {
  if (!isProjectId(id)) throw new Error(`"${id}" isn't a project id`);
  return path.join(DATA_DIR, id);
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const entries = await readdir(DATA_DIR, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const metas: ProjectMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isProjectId(entry.name)) continue;
    const meta = await readMeta(entry.name);
    if (meta) metas.push(meta);
  }
  return metas.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

export async function readMeta(id: string): Promise<ProjectMeta | null> {
  const text = await readFile(path.join(folder(id), "meta.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return null;
  const meta: unknown = JSON.parse(text);
  if (!isMeta(meta)) throw new Error(`data/${id}/meta.json isn't a project record`);
  return meta;
}

function isMeta(value: unknown): value is ProjectMeta {
  if (typeof value !== "object" || value === null) return false;
  const strings = ["id", "name", "addedAt"];
  const numbers = ["files", "edges", "routes", "skipped", "unresolved"];
  return (
    strings.every((k) => typeof Reflect.get(value, k) === "string") &&
    numbers.every((k) => typeof Reflect.get(value, k) === "number")
  );
}

export async function projectExists(id: string): Promise<boolean> {
  return (await readMeta(id)) !== null;
}

export async function readResult(id: string): Promise<ParseResult> {
  return deserializeParseResult(await readFile(path.join(folder(id), "result.json"), "utf8"));
}

/**
 * Writes a finished project into its folder, meta.json last. The list only
 * shows folders that have one, so a half-written project is never listed.
 * (Renaming a finished folder into place isn't an option: OneDrive holds the
 * files it has just seen, and Windows refuses to rename a folder with them.)
 */
export async function commitProject(staged: { resultJson: string; sourcesJson: string; meta: ProjectMeta }): Promise<void> {
  const target = folder(staged.meta.id);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  try {
    await writeFile(path.join(target, "result.json"), staged.resultJson);
    await writeFile(path.join(target, "sources.json"), staged.sourcesJson);
    await writeFile(path.join(target, "meta.json"), `${JSON.stringify(staged.meta, null, 2)}
`);
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

// ── model roles ─────────────────────────────────────────────────────────────

export async function readModelRoles(id: string): Promise<Record<string, ModelRole>> {
  const text = await readFile(path.join(folder(id), "model-roles.json"), "utf8").catch(missing);
  if (text === null) return {};
  const parsed: unknown = JSON.parse(text);
  const roles: Record<string, ModelRole> = {};
  if (typeof parsed === "object" && parsed !== null) {
    for (const [file, role] of Object.entries(parsed)) {
      if (typeof role !== "string" || !isModelRole(role)) throw new Error(`Stored model role "${String(role)}" on ${file} isn't one a model may give`);
      roles[file] = role;
    }
  }
  return roles;
}

export async function writeModelRole(id: string, file: string, role: ModelRole): Promise<void> {
  await serial(id, async () => {
    const roles = await readModelRoles(id);
    // A role already stored stays: the answer was cached, so it would be the same one.
    roles[file] ??= role;
    await writeFile(path.join(folder(id), "model-roles.json"), `${JSON.stringify(roles, null, 2)}\n`);
  });
}

// ── AI cache ────────────────────────────────────────────────────────────────

async function readCache(id: string): Promise<Record<string, string>> {
  const text = await readFile(path.join(folder(id), "ai-cache.json"), "utf8").catch(missing);
  if (text === null) return {};
  const parsed: unknown = JSON.parse(text);
  const cache: Record<string, string> = {};
  if (typeof parsed === "object" && parsed !== null) {
    for (const [key, body] of Object.entries(parsed)) if (typeof body === "string") cache[key] = body;
  }
  return cache;
}

export async function cacheRead(id: string, key: string): Promise<string | null> {
  return (await readCache(id))[key] ?? null;
}

export async function cacheWrite(id: string, key: string, body: string): Promise<void> {
  await serial(id, async () => {
    const cache = await readCache(id);
    cache[key] = body;
    await writeFile(path.join(folder(id), "ai-cache.json"), `${JSON.stringify(cache, null, 2)}\n`);
  });
}

// ── source ──────────────────────────────────────────────────────────────────

/** One parsed file's text, as the parser read it. */
export async function readSource(id: string, filePath: string): Promise<string | null> {
  const text = await readFile(path.join(folder(id), "sources.json"), "utf8");
  const sources: unknown = JSON.parse(text);
  if (typeof sources !== "object" || sources === null) throw new Error(`data/${id}/sources.json isn't a list of files`);
  const source: unknown = Object.hasOwn(sources, filePath) ? Reflect.get(sources, filePath) : undefined;
  return typeof source === "string" ? source : null;
}

// Writes to one project's files one at a time, so two Explain clicks can't
// each read the old cache and then overwrite each other's answer.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(id: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(id) ?? Promise.resolve()).then(work, work);
  queues.set(id, next.catch(() => undefined));
  return next;
}

function missing(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT") return null;
  throw error;
}
