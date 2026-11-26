import { ConvexProvider } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { lifeosHostName, sessionWaits, sessionWords } from "../shell/lifeos";
import { connectingWords } from "../shell/lifeosWords";
import { useKeptOpen } from "../shell/lifeosDown";
import { shared, useShared } from "../tasks/store";
import { createLifeosProjectsClient, type SectorKey as KitSector } from "work-kit/lifeos";
import { LIST_PLACE, projectPlace, Projects, ProjectsClientProvider, ProjectsKitProvider, type Project, type ProjectsPlace, type ProjectTask } from "work-kit/projects";
import "work-kit/projects/styles.css";
import "./projects.css";
import type { ProjectMeta } from "../../lib/tcserver/types";
import { openWorkView, useWorkView } from "../../lib/workSwitch";
import { dialogsChunk } from "../../surfaces/chunks";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { DocumentFrame, MARGIN_FROM, Scroller, useDocument, useOpened } from "../docs/DocumentCanvas";
import { CodeThreadDialog } from "../tasks/CodeThreadDialog";
import type { WorkViewProps } from "../views/registry";
import { BackToList, Bar, BarControls, BarTitle } from "./bar";
import { projectsKitFor, setProjectsHost, withHostDone } from "./kit";
import { LinkPicker, type LinkKind } from "./LinkPicker";
import { setProjectsBack, setProjectsHere } from "./here";
import { ProjectsBones } from "./bones";
import { Skeleton } from "../../components/ui/skeleton";
import { openDoc, placeOf, setPlace, useOpenedDoc, usePlace, type OpenedDoc } from "./place";

const ProjectSettingsDialog = dialogsChunk.surface("ProjectSettingsDialog");
// The Share sheet is its own chunk, loaded on the ⋯'s Share… press.
const ShareSheet = lazy(() => import("../guests/ShareSheet"));

const TASK_GET = makeFunctionReference<"query", { id: string }, { task: { projectId?: string } } | null>("tasks:get");

/**
 * A Work workspace's Projects (docs/agents/work-projects.md): the sector's
 * LifeOS projects on the shared project screens (work-kit/projects), read
 * and written through the workspace's own narrowed session. The list or
 * board of projects (the tracker's rows), a project's page (brief, plan,
 * files, log), a task's peek and page, and New project as a dialog; the place
 * is kept a workspace. A project's threads live in its mirror: New thread and Start a
 * thread open a composer there with the project or the task as its chip.
 */

/**
 * The header's name: the way back from inside a project, else "Projects". While the session cannot read, the screens
 * (and their bar) are not drawn: the way back to the list stays, from a project or a task, and needs no session.
 */
export function Title({ workspace, lifeos }: WorkViewProps) {
  const place = usePlace(workspace.id);
  if (!lifeos.client && place.at !== "list") return <BackToList onBack={() => setPlace(workspace.id, { ...LIST_PLACE, layout: place.layout })} />;
  return <BarTitle />;
}

/** The header's end: the screen's own controls (New project, New thread, New task, and the ⋯ with Board, Share, settings and Delete). */
export function Head(_props: WorkViewProps) {
  return <BarControls />;
}

/** The Work project whose settings sheet is open: the frame's (`Kept`), so a session that drops never takes what he typed. */
const settingsOpen = shared<ProjectMeta | null>(null);
const closeSettings = (): void => settingsOpen.set(null);

/**
 * Project settings…, the frame's (`WorkViewModule.Kept`), not the body's: the sheet reads the session itself and says
 * its line while it is down (`ProjectSettings`), so a drop takes the projects away, never the name he typed. A press made
 * while the session was on its way, which then went down, is dropped (`useKeptOpen`).
 */
export function Kept({ workspace, lifeos }: WorkViewProps) {
  const project = useShared(settingsOpen);
  useEffect(() => closeSettings, []);
  return useKeptOpen(project !== null, lifeos, closeSettings) && project ? <ProjectSettingsDialog project={project} workspace={workspace} onClose={closeSettings} /> : null;
}

export function View(props: WorkViewProps) {
  const { env, workspace, sector, lifeos, startThread } = props;
  const convex = lifeos.client;
  // Made once a session: the screens call the client's hooks in a fixed order.
  // Done goes through the host, so a task a thread worked completes with its thread's link (kit.tsx `withHostDone`).
  const client = useMemo(() => (convex ? withHostDone(createLifeosProjectsClient({ convex }), env, workspace.id) : null), [convex, env, workspace.id]);
  const kit = projectsKitFor(env, workspace.id);
  const place = usePlace(workspace.id);
  const onPlace = useCallback((next: ProjectsPlace) => setPlace(workspace.id, next), [workspace.id]);
  const doc = useOpenedDoc(workspace.id);
  // Where it stands, for the column's lit row (here.ts): a document or task counts as its project's page.
  const hereProject = doc ? doc.project.id : place.at === "project" ? (place.id ?? null) : place.at === "task" ? (place.from ?? null) : undefined;
  useLayoutEffect(() => setProjectsHere(workspace.id, hereProject === undefined ? { list: true } : { list: false, project: hereProject }), [workspace.id, hereProject]);
  useEffect(() => {
    setProjectsBack(workspace.id, () => {
      openDoc(workspace.id, null);
      setPlace(workspace.id, { ...LIST_PLACE, layout: placeOf(workspace.id).layout });
    });
    return () => {
      setProjectsHere(workspace.id, null);
      setProjectsBack(workspace.id, null);
    };
  }, [workspace.id]);
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
  const [sharing, setSharing] = useState<Project | null>(null);
  // What the kit reads at a press, set after each commit.
  useLayoutEffect(() => {
    setProjectsHost({
      workspace,
      sector,
      startThread,
      codeThread: setCoding,
      link: (project, kind) => setLinking({ project, kind }),
      settings: (project) => settingsOpen.set(project),
      share: setSharing,
      // LifeOS makes the sheet in the project's own sector; it shows in Files as the page's live read lands.
      newSheet: async (project) => {
        // A session with no client says its true state, the computer named (`sessionWords`), never a sign-out it is not.
        if (!convex) throw new Error(sessionWaits(lifeos) ? connectingWords(lifeosHostName(lifeos.environmentId)) : sessionWords(lifeos));
        await convex.mutation(makeFunctionReference<"mutation">("sheets:create"), { projectId: project.id, title: "Untitled" });
      },
    });
  });
  // Bones only while the session is on its way; a failed one is the frame's to say, with nothing pulsing under it.
  if (!convex || !client) return sessionWaits(lifeos) ? <ProjectsBones shape={place.at === "project" || place.at === "task" ? place.at : "list"} /> : null;
  return (
    <ConvexProvider client={convex}>
      <ProjectsKitProvider kit={kit}>
        <ProjectsClientProvider client={client}>
          <div className="tc-projects h-full min-h-0">{doc ? <DocInPlace env={env} workspaceId={workspace.id} doc={doc} /> : <Projects sector={sector as KitSector} place={place} onPlace={onPlace} />}</div>
          {coding ? <CodeThreadDialog task={{ _id: coding.id, title: coding.title }} sector={sector} onStart={startThread} onClose={() => setCoding(null)} /> : null}
          {linking ? <LinkPicker env={env} workspaceId={workspace.id} project={linking.project} kind={linking.kind} onClose={() => setLinking(null)} /> : null}
          {sharing ? (
            <Suspense fallback={null}>
              <ShareSheet env={env} target={{ source: { at: "lifeos", table: "projects", id: sharing.id } }} title={sharing.name} onClose={() => setSharing(null)} />
            </Suspense>
          ) : null}
        </ProjectsClientProvider>
      </ProjectsKitProvider>
    </ConvexProvider>
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
      <Bar back={{ label: doc.project.name, run: back }}>{null}</Bar>
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
