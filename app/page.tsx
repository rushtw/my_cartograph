import Link from "next/link";
import { connection } from "next/server";
import { AppHeader } from "@/components/app-header";
import { LoadForm } from "@/components/load-form";
import { listProjects } from "@/lib/store/projects";
import { ago } from "@/lib/time";

// The front door: load one project, and below it every project stored before.
export default async function LandingPage() {
  // The list is the data folder as it is now, and "3h ago" is worked out once
  // here; nothing ticks in the browser.
  const { projects, now } = await load();

  return (
    <>
      <AppHeader />
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl px-3 py-6">
          <LoadForm />

          <section className="mt-8">
            <h2 className="flex items-baseline justify-between text-[11px] text-fg-muted">
              <span>Stored projects</span>
              <span className="tabular-nums">{projects.length}</span>
            </h2>
            {projects.length === 0 ? (
              <p className="mt-2 text-xs text-fg-muted">None yet. A project appears here once it has been loaded.</p>
            ) : (
              <table className="mt-1 w-full table-fixed border-collapse text-xs">
                <colgroup>
                  <col />
                  <col className="w-16" />
                  <col className="w-16" />
                  <col className="w-16" />
                  <col className="w-20" />
                </colgroup>
                <thead className="text-left text-fg-muted">
                  <tr className="h-7 border-b border-line">
                    <th className="font-normal">Project</th>
                    <th className="text-right font-normal">Files</th>
                    <th className="text-right font-normal">Imports</th>
                    <th className="text-right font-normal">Routes</th>
                    <th className="text-right font-normal">Added</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id} className="h-7 border-b border-line hover:bg-raised">
                      <td className="truncate">
                        <Link href={`/projects/${p.id}`} className="font-mono text-[13px] hover:underline">
                          {p.name}
                        </Link>
                        {(p.skipped > 0 || p.unresolved > 0) && (
                          <span className="ml-2 text-[11px] text-fg-muted">
                            {[p.skipped > 0 && `${p.skipped} skipped`, p.unresolved > 0 && `${p.unresolved} unresolved`].filter(Boolean).join(", ")}
                          </span>
                        )}
                      </td>
                      <td className="text-right tabular-nums">{p.files}</td>
                      <td className="text-right tabular-nums">{p.edges}</td>
                      <td className="text-right tabular-nums">{p.routes}</td>
                      <td className="text-right text-fg-muted tabular-nums">
                        <time dateTime={p.addedAt} title={p.addedAt}>
                          {ago(p.addedAt, now)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

async function load() {
  await connection();
  return { projects: await listProjects(), now: Date.now() };
}
