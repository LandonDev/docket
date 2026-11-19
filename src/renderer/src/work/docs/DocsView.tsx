import { useMemo, useState, useSyncExternalStore } from "react";
import type { CanvasSource } from "@shared/work";
import { ChevronLeft } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { loadToast } from "../../components/ui/toaster";
import { refusalWords } from "../../lib/settingsHome";
import { Skeleton } from "../../components/ui/skeleton";
import { dayTime } from "../../lib/duration";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { Doc } from "../icons";
import { useLifeosQuery } from "../shell/lifeos";
import type { WorkViewProps } from "../views/registry";
import { DocumentFrame, MARGIN_FROM, Scroller, useDocument, useOpened } from "./DocumentCanvas";
import type { DocHost } from "./host";
import type { DocOpen } from "@shared/contract-work-docs";
import { registry } from "../../lib/connection";

/**
 * The Docs view of a linked Work workspace (docs/agents/work-docs.md "The
 * Docs view"; the approved prototype, workspace.html): the sector's LifeOS
 * documents, one line each, grouped by project, newest first. A row opens
 * the document right here, in the shared editor; Ask starts a thread about
 * it. Suggestions are stepped in a thread's canvas, where the agent works.
 * The list reads 25 at a time; Show more reads the next 25.
 */

/** How many documents the list reads at a time. */
const PAGE = 25;

type DocRow = { _id: string; title: string; projectId?: string; editedAt?: number; _creationTime: number };
type Page = { page: DocRow[]; isDone: boolean };
type Project = { _id: string; name: string };

/** Which document each workspace's view has open: the header and the body read it. */
const opened = new Map<string, { id: string; title: string } | null>();
const listeners = new Set<() => void>();
function setOpened(workspaceId: string, doc: { id: string; title: string } | null): void {
  opened.set(workspaceId, doc);
  for (const l of listeners) l();
}
function useOpenedDoc(workspaceId: string): { id: string; title: string } | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => opened.get(workspaceId) ?? null,
  );
}

const sourceOf = (id: string): CanvasSource => ({ at: "lifeos", table: "docs", id });

export function View(props: WorkViewProps) {
  const doc = useOpenedDoc(props.workspace.id);
  // Retry mounts the list again, so its query is asked anew.
  const [attempt, setAttempt] = useState(0);
  return doc ? <OpenDoc {...props} doc={doc} /> : <DocList key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

/** The header's verb: New on the list, Ask on a document. */
export function Head({ env, workspace, sector, startThread }: WorkViewProps) {
  const doc = useOpenedDoc(workspace.id);
  const [making, setMaking] = useState(false);
  if (doc)
    return (
      <Button variant="ghost" size="sm" onClick={() => startThread({ kind: "selection", label: doc.title, ref: sourceOf(doc.id) })}>
        Ask
      </Button>
    );
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={making}
      onClick={async () => {
        setMaking(true);
        try {
          const made = await registry.linkOf(env).request<{ source: { id: string }; title: string }>("work.docs.create", { sector, title: "Untitled" });
          setOpened(workspace.id, { id: made.source.id, title: made.title });
        } catch (err) {
          void loadToast().then((toast) => toast.error("The document was not made", { description: refusalWords(err) || undefined }));
        } finally {
          setMaking(false);
        }
      }}
    >
      <BusyLabel busy={making} label="New" />
    </Button>
  );
}

function DocList({ workspace, sector, lifeos, onRetry }: WorkViewProps & { onRetry: () => void }) {
  const [count, setCount] = useState(PAGE);
  const docs = useLifeosQuery<Page>(lifeos, "docs:list", { sector, paginationOpts: { numItems: count, cursor: null } });
  // While the longer read loads, the rows already shown stay.
  const [shown, setShown] = useState<Page | null>(null);
  if (docs.status === "ready" && docs.value !== shown) setShown(docs.value);
  const projects = useLifeosQuery<Project[]>(lifeos, "projects:list", { sector });
  const page = docs.status === "ready" ? docs.value : shown;
  const groups = useMemo(() => {
    if (!page) return null;
    const names = new Map((projects.status === "ready" ? projects.value : []).map((p) => [p._id, p.name]));
    const by = new Map<string, DocRow[]>();
    for (const row of page.page) {
      const key = row.projectId && names.has(row.projectId) ? row.projectId : "";
      by.set(key, [...(by.get(key) ?? []), row]);
    }
    return [...by].map(([key, rows]) => ({ key, name: key ? names.get(key)! : "Other", rows })).sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : 0));
  }, [page, projects]);

  if (docs.status === "failed") return <EmptyState title="Docs did not load" line={docs.error} action={{ label: "Retry", onClick: onRetry }} />;
  if (!groups)
    return (
      <div aria-busy className="mx-auto flex max-w-[720px] flex-col gap-3 px-6 py-5">
        <Skeleton className="h-3 w-[18%]" />
        <Skeleton className="h-3 w-[70%]" />
        <Skeleton className="h-3 w-[56%]" />
        <Skeleton className="h-3 w-[62%]" />
      </div>
    );
  if (groups.length === 0) return <EmptyState title="No documents" />;
  return (
    <div className="mx-auto max-w-[720px] px-6 py-5">
      {groups.map((g, i) => (
        <section key={g.key} className={i ? "mt-5" : undefined}>
          <h2 className="mb-1 text-xs font-medium text-muted-foreground">{g.name}</h2>
          {g.rows.map((row) => (
            <ItemButton
              key={row._id}
              size="xs"
              onClick={() => setOpened(workspace.id, { id: row._id, title: row.title })}
              className={`-mx-2 h-8 w-[calc(100%+16px)] min-w-0 flex-nowrap rounded-md py-0 text-[13px] ${ROW_PRESS}`}
            >
              <Doc className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground">{row.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{dayTime(row.editedAt ?? row._creationTime)}</span>
            </ItemButton>
          ))}
        </section>
      ))}
      {page && !page.isDone ? (
        <Button variant="ghost" size="sm" className="-ms-2 mt-3" disabled={docs.status === "loading"} onClick={() => setCount((n) => n + PAGE)}>
          <BusyLabel busy={docs.status === "loading"} label="Show more" />
        </Button>
      ) : null}
    </div>
  );
}

function OpenDoc({ env, workspace, doc }: WorkViewProps & { doc: { id: string; title: string } }) {
  const source = useMemo(() => sourceOf(doc.id), [doc.id]);
  const [attempt, setAttempt] = useState(0);
  const got = useOpened(env, source, attempt);
  const [scrollTop, setScrollTop] = useState(0);
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-2">
        <Button variant="ghost" size="xs" onClick={() => setOpened(workspace.id, null)}>
          <ChevronLeft className="size-3.5" />
          Docs
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <Scroller scrollTop={scrollTop} onScroll={setScrollTop}>
          {(width) =>
            got && "open" in got ? (
              <ViewDoc key={got.open.doc} host={got.host} open={got.open} margin={width >= MARGIN_FROM} />
            ) : got && "error" in got ? (
              <EmptyState title="It did not open" line={got.error} action={{ label: "Retry", onClick: () => setAttempt((n) => n + 1) }} />
            ) : (
              <div aria-busy className="mx-auto flex max-w-[724px] flex-col gap-2.5 pl-[52px]">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="mt-4 h-3 w-[92%]" />
                <Skeleton className="h-3 w-[78%]" />
              </div>
            )
          }
        </Scroller>
      </div>
    </div>
  );
}

function ViewDoc({ host, open, margin }: { host: DocHost; open: DocOpen; margin: boolean }) {
  const doc = useDocument(host, open);
  return <DocumentFrame doc={doc} open={open} margin={margin} />;
}
