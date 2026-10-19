"use server";

import { createHash } from "node:crypto";
import { classifyFile, explainFile, explainFolder, type Cache } from "@/lib/ai/tasks";
import { fileInput, folderInput } from "@/lib/analysis/context";
import type { ModelRole } from "@/lib/roles";
import { cacheRead, cacheWrite, isProjectId, readMeta, readModelRoles, readResult, readSource, writeModelRole } from "@/lib/store/projects";

export type ExplainResult =
  | {
      ok: true;
      body: string;
      model: string;
      cached: boolean;
      /** Set when this call labelled a file no convention identified. */
      labelled: { role: ModelRole | null } | null;
      /** Why labelling failed, when it did; the explanation still stands. */
      labelError: string | null;
    }
  | { ok: false; error: string };

export async function explainFileAction(projectId: string, path: string): Promise<ExplainResult> {
  try {
    const project = await load(projectId);
    const storedRole = (await readModelRoles(projectId))[path] ?? null;
    const loaded = fileInput(project.result, path, storedRole);
    if (!loaded) return { ok: false, error: `${path} isn't a file in this project` };
    const hash = loaded.input.hash;
    const cache = cacheFor(projectId);
    const source = sourceOf(projectId, path, hash);

    // Labelling comes first so the explanation's question includes the role,
    // and asks the same question next time, when the role is read back stored.
    let labelled: { role: ModelRole | null } | null = null;
    let labelError: string | null = null;
    if (!loaded.hasConventionRole && storedRole === null) {
      try {
        const { role } = await classifyFile(loaded.classify, { cache, source });
        labelled = { role };
        if (role !== null) {
          await writeModelRole(projectId, path, role);
          loaded.input.role = role;
        }
      } catch (error) {
        labelError = messageOf(error);
      }
    }

    const answer = await explainFile(loaded.input, { cache, source });
    return { ok: true, ...answer, labelled, labelError };
  } catch (error) {
    console.error(`Explaining ${path} failed:`, error);
    return { ok: false, error: messageOf(error) };
  }
}

export async function explainFolderAction(projectId: string, dir: string): Promise<ExplainResult> {
  try {
    const { result } = await load(projectId);
    const input = folderInput(result, dir);
    if (!input) return { ok: false, error: `${dir} isn't a folder on this map` };
    const answer = await explainFolder(input, { cache: cacheFor(projectId) });
    return { ok: true, ...answer, labelled: null, labelError: null };
  } catch (error) {
    console.error(`Explaining folder ${dir} failed:`, error);
    return { ok: false, error: messageOf(error) };
  }
}

async function load(projectId: string) {
  if (!isProjectId(projectId)) throw new Error("That isn't a project");
  const meta = await readMeta(projectId);
  if (!meta) throw new Error("Project not found");
  return { meta, result: await readResult(projectId) };
}

function cacheFor(projectId: string): Cache {
  return { read: (key) => cacheRead(projectId, key), write: (key, body) => cacheWrite(projectId, key, body) };
}

// Read from the stored copy at most once per request, and only if a cache miss
// needs it. The text must be what the parser read; if it hashes differently,
// explaining it would describe code that isn't on the map.
function sourceOf(projectId: string, path: string, hash: string): () => Promise<string> {
  let pending: Promise<string> | null = null;
  return () => {
    pending ??= (async () => {
      const text = await readSource(projectId, path);
      if (text === null) throw new Error(`No stored source for ${path}`);
      if (createHash("sha256").update(text).digest("hex") !== hash) throw new Error(`The stored copy of ${path} isn't byte-identical to what was parsed (it may not be valid UTF-8)`);
      return text;
    })();
    return pending;
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
