import type { ClassifyInput, FileInput, FolderFile, FolderInput, NeighbourFacts } from "../ai/prompts.ts";
import { foldDirectories } from "../graph/fold.ts";
import { EDGE_KINDS, type EdgeKind, type ParseResult } from "../parser/types.ts";

// What the model is handed, worked out from the stored parse result and
// nowhere else. The browser names a file or folder; which files are its
// neighbours is read here from the parser's edges, never taken from the
// request.

type Facts = { path: string; exports: string[]; role: string | null };

// A model's label for one file must not change what another file's question
// says, or it would throw away that file's cached answer for nothing the
// parser found. So neighbours carry convention roles only.
function factsOf(result: ParseResult): Map<string, Facts> {
  return new Map(result.files.map((f) => [f.path, { path: f.path, exports: f.exports, role: f.role }]));
}

export function fileInput(
  result: ParseResult,
  path: string,
  modelRole: string | null,
): { input: FileInput; classify: ClassifyInput; hasConventionRole: boolean } | null {
  const facts = factsOf(result);
  const file = result.files.find((f) => f.path === path);
  if (!file) return null;

  const imports = new Map<string, NeighbourFacts>();
  const importedBy = new Map<string, NeighbourFacts>();
  for (const e of result.edges) {
    // A file importing itself sits in both lists, as in the parser's own counts.
    if (e.source === path) add(imports, facts, e.target, e.kind, e.typeOnly);
    if (e.target === path) add(importedBy, facts, e.source, e.kind, e.typeOnly);
  }

  const input: FileInput = {
    path,
    hash: file.hash,
    role: file.role ?? modelRole,
    reachedBy: file.reachedBy,
    exports: file.exports,
    imports: sorted(imports),
    importedBy: sorted(importedBy),
  };
  const classify: ClassifyInput = {
    path,
    hash: file.hash,
    exports: file.exports,
    imports: input.imports.map((n) => ({ path: n.path, role: n.role })),
    importedBy: input.importedBy.map((n) => ({ path: n.path, role: n.role })),
  };
  return { input, classify, hasConventionRole: file.role !== null };
}

// The folder is a group of the same folding the map draws, worked out from the
// same parsed file list, so the question is about the box that was clicked.
export function folderInput(result: ParseResult, dir: string): FolderInput | null {
  const group = foldDirectories(result.files).groups.find((g) => g.dir === dir);
  if (!group) return null;
  const inside = new Set(group.files);
  const incoming = new Map<string, { from: string; to: string }>();
  const outgoing = new Map<string, { from: string; to: string }>();
  for (const e of result.edges) {
    if (!inside.has(e.source) && inside.has(e.target)) incoming.set(`${e.source}\0${e.target}`, { from: e.source, to: e.target });
    if (inside.has(e.source) && !inside.has(e.target)) outgoing.set(`${e.source}\0${e.target}`, { from: e.source, to: e.target });
  }
  const byPath = new Map(result.files.map((f) => [f.path, f]));
  const files: FolderFile[] = group.files.map((p) => {
    const f = byPath.get(p);
    if (!f) throw new Error(`Folded file ${p} isn't in the file list it was folded from`);
    return { path: f.path, hash: f.hash, role: f.role, exports: f.exports, fanIn: f.fanIn, fanOut: f.fanOut };
  });
  const order = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
  return { dir, files, incoming: [...incoming.values()].sort(order), outgoing: [...outgoing.values()].sort(order) };
}

function add(into: Map<string, NeighbourFacts>, facts: ReadonlyMap<string, Facts>, other: string, kind: EdgeKind, typeOnly: boolean): void {
  const known = facts.get(other);
  if (!known) throw new Error(`An edge points at ${other}, which isn't a parsed file`);
  const existing = into.get(other);
  if (!existing) {
    into.set(other, { path: other, role: known.role, exports: known.exports, kinds: [kind], typeOnly });
    return;
  }
  if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
  existing.typeOnly &&= typeOnly;
}

function sorted(map: Map<string, NeighbourFacts>): NeighbourFacts[] {
  return [...map.values()]
    .map((n) => ({ ...n, kinds: EDGE_KINDS.filter((k) => n.kinds.includes(k)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
