import { ConvexProvider } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createLifeosProjectsClient, type SectorKey as KitSector } from "work-kit/lifeos";
import { projectPlace, Projects, ProjectsClientProvider, ProjectsKitProvider, type Project, type ProjectsPlace, type ProjectTask } from "work-kit/projects";
import "work-kit/projects/styles.css";
import "./projects.css";
import { ArrowLeft } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { openWorkView, useWorkView } from "../../lib/workSwitch";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { DocumentFrame, MARGIN_FROM, Scroller, useDocument, useOpened } from "../docs/DocumentCanvas";
import { CodeThreadDialog } from "../tasks/CodeThreadDialog";
import type { WorkViewProps } from "../views/registry";
import { Bar, BarControls, BarTitle } from "./bar";
import { projectsKitFor, setProjectsHost } from "./kit";
import { LinkPicker, type LinkKind } from "./LinkPicker";
import { openDoc, placeOf, setPlace, useOpenedDoc, usePlace, type OpenedDoc } from "./place";

const TASK_GET = makeFunctionReference<"query", { id: string }, { task: { projectId?: string } } | null>("tasks:get");

/**
 * A Work workspace's Projects (docs/agents/work-projects.md): the sector's
 * LifeOS projects on the shared project screens (work-kit/projects), read
 * and written through the workspace's own narrowed session. The list or
 * board of projects, a project's page with its tree, board, documents and
 * activity, a task's peek and page, and New project; the place is kept a
 * workspace. A project's threads live in its mirror: New thread and Start a
 * thread open a composer there with the project or the task as its chip.
 */

/** The header's name: the way back from inside a project, else "Projects". */
export function Title(_props: WorkViewProps) {
  return <BarTitle />;
}

/** The header's end: the screen's own controls (List or Board, New project, New thread, New task). */
export function Head(_props: WorkViewProps) {
  return <BarControls />;
}

export function View(props: WorkViewProps) {
  const { env, workspace, sector, lifeos, startThread } = props;
  const convex = lifeos.client;
  // Made once a session: the screens call the client's hooks in a fixed order.
  const client = useMemo(() => (convex ? createLifeosProjectsClient({ convex }) : null), [convex]);
  const kit = projectsKitFor(env, workspace.id);
  const place = usePlace(workspace.id);
  const onPlace = useCallback((next: ProjectsPlace) => setPlace(workspace.id, next), [workspace.id]);
  const doc = useOpenedDoc(workspace.id);
  // A card's Open project names where to stand: taken once, then cleared, so the row's own press comes back to where he was.
  const asked = useWorkView();
  const mine = asked?.workspaceId === workspace.id && asked.view === "projects" ? asked : null;
  const project = mine?.project;
  const task = mine?.task;
  useEffect(() => {
    if (!project && !task) return;
    const was = placeOf(workspace.id);
    openDoc(workspace.id, null);
    setPlace(workspace.id, task ? { at: "task", id: task, layout: was.layout, tab: "all", display: was.display } : projectPlace(project!, was));
    openWorkView({ workspaceId: workspace.id, view: "projects" });
    // A card's own page goes back to its project: the chip names the task alone, so LifeOS is asked which project holds it.
    if (task && convex)
      void convex.query(TASK_GET, { id: task }).then(
        (got) => {
          const now = placeOf(workspace.id);
          if (got?.task.projectId && now.at === "task" && now.id === task && !now.from) setPlace(workspace.id, { ...now, from: got.task.projectId });
        },
        () => {},
      );
  }, [project, task, workspace.id, convex]);
  const [coding, setCoding] = useState<ProjectTask | null>(null);
  const [linking, setLinking] = useState<{ project: Project; kind: LinkKind } | null>(null);
  // What the kit reads at a press, set after each commit.
  useLayoutEffect(() => {
    setProjectsHost({
      workspace,
      sector,
      startThread,
      codeThread: setCoding,
      link: (project, kind) => setLinking({ project, kind }),
      // LifeOS makes the sheet in the project's own sector; it shows in Documents as the page's live read lands.
      newSheet: async (project) => {
        if (!convex) throw new Error("LifeOS is not connected");
        await convex.mutation(makeFunctionReference<"mutation">("sheets:create"), { projectId: project.id, title: "Untitled" });
      },
    });
  });
  // The frame says signed out and unreachable; with no client yet the session is on its way.
  if (!convex || !client) return <Bones />;
  return (
    <ConvexProvider client={convex}>
      <ProjectsKitProvider kit={kit}>
        <ProjectsClientProvider client={client}>
          <div className="tc-projects h-full min-h-0">{doc ? <DocInPlace env={env} workspaceId={workspace.id} doc={doc} /> : <Projects sector={sector as KitSector} place={place} onPlace={onPlace} />}</div>
          {coding ? <CodeThreadDialog task={{ _id: coding.id, title: coding.title }} sector={sector} onStart={startThread} onClose={() => setCoding(null)} /> : null}
          {linking ? <LinkPicker env={env} workspaceId={workspace.id} project={linking.project} kind={linking.kind} onClose={() => setLinking(null)} /> : null}
        </ProjectsClientProvider>
      </ProjectsKitProvider>
    </ConvexProvider>
  );
}

/** The list's shape while the session is on its way: a group head and its rows. */
function Bones() {
  return (
    <div aria-busy aria-label="Loading Projects" className="mx-auto flex w-full max-w-[52rem] flex-col gap-1 px-4 pt-6">
      <Skeleton className="mb-2 h-3 w-20" />
      {["w-2/5", "w-1/3", "w-1/2", "w-1/4"].map((w) => (
        <div key={w} className="flex h-8 items-center gap-3">
          <Skeleton className="size-3.5 rounded-full" />
          <Skeleton className={`h-3 ${w}`} />
        </div>
      ))}
    </div>
  );
}

/** A LifeOS document of a project, opened in place in the shared editor, with the way back to its project in the header. */
function DocInPlace({ env, workspaceId, doc }: { env: string; workspaceId: string; doc: OpenedDoc }) {
  const [attempt, setAttempt] = useState(0);
  const got = useOpened(env, doc.source, attempt);
  const [scrollTop, setScrollTop] = useState(0);
  const back = (): void => openDoc(workspaceId, null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Bar
        crumb={
          <>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Back to ${doc.project.name}`} className="text-muted-foreground" onClick={back}>
              <ArrowLeft />
            </Button>
            <span className="min-w-0 truncate">{doc.project.name}</span>
          </>
        }
      >
        {null}
      </Bar>
      <div className="min-h-0 flex-1 pt-4">
        <Scroller scrollTop={scrollTop} onScroll={setScrollTop}>
          {(width) =>
            got && "open" in got ? (
              <Opened key={got.open.doc} got={got} margin={width >= MARGIN_FROM} />
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

function Opened({ got, margin }: { got: Extract<NonNullable<ReturnType<typeof useOpened>>, { open: unknown }>; margin: boolean }) {
  const handle = useDocument(got.host, got.open);
  return <DocumentFrame doc={handle} open={got.open} margin={margin} />;
}
