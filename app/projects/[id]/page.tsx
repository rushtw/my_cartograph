import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AppHeader } from "@/components/app-header";
import { AnalysisView } from "@/components/analysis-view";
import { isProjectId, readMeta, readModelRoles, readResult } from "@/lib/store/projects";

export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  if (!isProjectId(id)) notFound();
  await connection();
  const meta = await readMeta(id);
  if (!meta) notFound();

  // Read back through the parser's contract: a result written by another
  // version, or edited by hand, fails here by field name instead of drawing.
  let result;
  try {
    result = await readResult(id);
  } catch (error) {
    return (
      <>
        <AppHeader />
        <div className="px-3 py-3 text-xs">
          <p>This project&apos;s stored result can&apos;t be read.</p>
          <p className="mt-0.5 break-words text-fg-muted">{error instanceof Error ? error.message : String(error)}</p>
        </div>
      </>
    );
  }
  const modelRoles = await readModelRoles(id);

  return (
    <>
      <AppHeader />
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-3 text-xs">
        <h1 className="font-mono text-[13px]">{meta.name}</h1>
        <span className="text-fg-muted">
          added <time dateTime={meta.addedAt}>{meta.addedAt.slice(0, 10)}</time>
        </span>
      </div>
      <AnalysisView
        files={result.files}
        edges={result.edges}
        routes={result.routes}
        routeCoverage={result.coverage.routes}
        modelRoles={modelRoles}
        projectId={meta.id}
        repository={{
          name: meta.name,
          projects: result.projects,
          skipped: result.coverage.files.skipped,
          unresolved: result.coverage.imports.total.unresolved,
        }}
      />
    </>
  );
}
