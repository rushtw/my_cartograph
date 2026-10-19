import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { serializeParseResult } from "../parser/contract.ts";
import { parseSelection, selectFiles } from "../parser/index.ts";
import type { ParseResult } from "../parser/types.ts";
import { commitProject, projectExists, type ProjectMeta } from "../store/projects.ts";
import { Zip, ZipError, type ZipEntry } from "../zip.ts";
import type { Stage } from "./stages.ts";

// Zip in, stored project out: extract → select → parse → store. The parser is
// handed a plain folder, exactly as it would be on the command line; nothing
// in here decides what an import means.

export class IngestError extends Error {
  override name = "IngestError";
  readonly stage: Stage;
  constructor(message: string, stage: Stage) {
    super(message);
    this.stage = stage;
  }
}

// Limits stated rather than engineered round: there is no queue or worker.
const MAX_ENTRIES = 500_000;
const MAX_EXTRACTED_BYTES = 1024 ** 3;
// Files read for real: code, and the JSON the resolver and walker read (package.json, tsconfig…).
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const JSON_FILE = /\.json$/;

export type Report = (stage: Stage, message: string) => void;
export type Outcome = { id: string; alreadyStored: boolean };

export async function ingestZip(zipPath: string, displayName: string, report: Report): Promise<Outcome> {
  const workdir = await mkdtemp(path.join(tmpdir(), "my-cartograph-"));
  // The last stage reported is where a failure is blamed.
  let stage: Stage = "extract";
  const enter: Report = (next, message) => {
    stage = next;
    report(next, message);
  };
  try {
    enter("extract", "Reading the zip's directory");
    const zip = await openZip(zipPath);
    try {
      await extractTo(zip, workdir, enter);
    } finally {
      await zip.close();
    }

    enter("select", "Walking the project for TypeScript and JavaScript files");
    const selection = selectFiles(workdir);
    const { candidates, skipped } = selection.walk;

    enter("parse", `Parsing ${count(candidates.length, "file")}${skipped.length ? `, ${skipped.length} skipped` : ""}`);
    // Parsing is synchronous; let the stage message leave before it starts.
    await new Promise((resolve) => setImmediate(resolve));
    const parsed = parseSelection(selection);

    enter("store", `Storing ${count(parsed.files.length, "file")} and ${count(parsed.edges.length, "edge")}`);
    // The root is the temporary folder; what's stored is the project's name.
    const result: ParseResult = { ...parsed, root: displayName };
    const id = fingerprint(result);
    if (await projectExists(id)) return { id, alreadyStored: true };

    const meta: ProjectMeta = {
      id,
      name: displayName,
      addedAt: new Date().toISOString(),
      files: result.files.length,
      edges: result.edges.length,
      routes: result.routes.length,
      skipped: result.coverage.files.skipped,
      unresolved: result.coverage.imports.total.unresolved,
    };
    // The zip is deleted once loaded, so Explain reads from this copy of the
    // parsed files' text instead. Only files the parser read are kept.
    const parsedPaths = new Set(result.files.map((f) => f.path));
    const sources: Record<string, string> = {};
    for (const c of candidates) if (parsedPaths.has(c.path)) sources[c.path] = c.content;
    await commitProject({ resultJson: serializeParseResult(result), sourcesJson: JSON.stringify(sources), meta });
    return { id, alreadyStored: false };
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(error instanceof Error ? error.message : String(error), stage);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function openZip(zipPath: string): Promise<Zip> {
  try {
    return await Zip.open(zipPath);
  } catch (error) {
    if (error instanceof ZipError) throw new IngestError(error.message, "extract");
    throw error;
  }
}

// Same files, same project, whatever the zip is called or how it was packed.
function fingerprint(result: ParseResult): string {
  const hash = createHash("sha256");
  for (const f of result.files) hash.update(`${f.path}\0${f.hash}\n`);
  for (const f of result.coverage.files.skippedFiles) hash.update(`skip:${f.path}\0${f.reason}\n`);
  return hash.digest("hex").slice(0, 16);
}

// ── extraction ──────────────────────────────────────────────────────────────

async function extractTo(zip: Zip, dir: string, report: Report): Promise<void> {
  if (zip.entries.length > MAX_ENTRIES) {
    throw new IngestError(`The zip has ${zip.entries.length.toLocaleString("en-US")} entries, over the ${MAX_ENTRIES.toLocaleString("en-US")} this can unpack`, "extract");
  }
  for (const entry of zip.entries) checkName(entry);
  const prefix = wrapperOf(zip.entries);

  let done = 0;
  let extractedBytes = 0;
  const made = new Set<string>();
  const total = zip.entries.length;
  for (const entry of zip.entries) {
    if (++done % 2000 === 0) report("extract", `Unpacking ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} entries`);
    const relative = entry.name.slice(prefix.length);
    if (relative === "" ) continue;
    const segments = relative.replace(/\/$/, "").split("/");
    // Dependencies and dot-directories are never parsed. The folder itself is
    // created empty so the parser still lists it as excluded, with its reason.
    // Only folders count: a dot-file such as .eslintrc.js is an ordinary file.
    const folders = entry.isDirectory ? segments : segments.slice(0, -1);
    const excluded = folders.findIndex((s) => s === "node_modules" || s.startsWith("."));
    if (excluded !== -1) {
      const excludedDir = path.join(dir, ...segments.slice(0, excluded + 1));
      if (!made.has(excludedDir)) {
        made.add(excludedDir);
        await mkdir(excludedDir, { recursive: true });
      }
      continue;
    }
    if (entry.isSymlink) {
      // A link is recorded as a link, never followed or written.
      continue;
    }
    const destination = path.join(dir, ...segments);
    if (entry.isDirectory) {
      await mkdir(destination, { recursive: true });
      continue;
    }
    const real = CODE.test(relative) || JSON_FILE.test(relative);
    if (real) {
      extractedBytes += entry.size;
      if (extractedBytes > MAX_EXTRACTED_BYTES) {
        throw new IngestError(`The code and config in the zip add up to more than ${MAX_EXTRACTED_BYTES / 1024 ** 3} GB, the most this can unpack`, "extract");
      }
      try {
        await zip.extract(entry, destination);
      } catch (error) {
        if (error instanceof ZipError) throw new IngestError(error.message, "extract");
        throw error;
      }
    } else {
      // Images, stylesheets and the like are never read. An empty file stands
      // in so an import of one still resolves to something that exists.
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, "");
    }
  }
}

// An entry that names a place outside the folder is refused outright: the
// whole zip is suspect, not just that file.
function checkName(entry: ZipEntry): void {
  const name = entry.name;
  const unsafe = name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..") || name.includes("\0");
  if (unsafe) throw new IngestError(`The zip contains an entry that leaves its folder: ${name.slice(0, 120)}`, "extract");
}

// GitHub's "Download ZIP" puts everything under one folder (repo-main/). If
// every entry shares one top-level folder, that folder isn't part of the
// project.
function wrapperOf(entries: readonly ZipEntry[]): string {
  let top: string | null = null;
  for (const entry of entries) {
    const slash = entry.name.indexOf("/");
    if (slash === -1) return "";
    const first = entry.name.slice(0, slash + 1);
    if (top === null) top = first;
    else if (top !== first) return "";
  }
  return top ?? "";
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

export function incomingName(): string {
  return `.incoming-${randomBytes(6).toString("hex")}.zip`;
}
