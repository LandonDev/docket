import { useState } from "react";
import { FIXTURE_NOW, fakeProjectsClient, Projects, ProjectsClientProvider, ProjectsKitProvider, type ProjectsKit, type ProjectsPlace } from "work-kit/projects";
import "work-kit/projects/styles.css";
import "./projects.css";
import { MessageSquare, Outbox } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import { Project } from "../icons";
import { BarControls, BarTitle } from "./bar";
import { projectsKitFor } from "./kit";

/**
 * The project screens as TempCode draws them, still, for `bun run ui:preview
 * src/renderer/src/work/projects/ProjectsView.preview.tsx#ProjectsPreview`:
 * the view's 40px header and the shared screens under it, on work-kit's
 * fixtures (one sector, every project state, a tree three levels deep).
 * Rendered by nothing in the app.
 */

// The static renderer's document has no element scrolling; the peek asks for it as it opens.
if (typeof Element !== "undefined" && !Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

const PLACES: Record<string, ProjectsPlace> = {
  list: { at: "list", layout: "list", tab: "all" },
  board: { at: "list", layout: "board", tab: "all" },
  project: { at: "project", id: "p-lan", layout: "list", tab: "all" },
  projectBoard: { at: "project", id: "p-lan", layout: "board", tab: "all" },
  peek: { at: "project", id: "p-lan", layout: "list", tab: "all", peek: "t-network" },
  task: { at: "task", id: "t-network", layout: "list", tab: "all", from: "p-lan" },
  new: { at: "new", layout: "list", tab: "all" },
};

// The kit as the view makes it, with a thread mark that needs no LifeOS session: one task has a thread.
const base = projectsKitFor("preview", "preview");
const kit: ProjectsKit = {
  ...base,
  Document: ({ lead }) => <p className="text-[13px] leading-5 text-foreground">{lead}</p>,
  taskMark: ({ task }) =>
    task.id === "t-network" ? (
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Open thread">
        <MessageSquare />
      </Button>
    ) : null,
  threads: {
    ...base.threads!,
    Mark: ({ task }) =>
      task.id === "t-network" ? (
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Open thread">
          <MessageSquare />
        </Button>
      ) : null,
  },
};

const HOUR = 3_600_000;
/**
 * The kit with its thread slots filled as M7 fills them from the thread record: a Threads column on
 * the list, a held thread in the Log, the files a thread made. Words and marks only, for the look.
 */
const filled: ProjectsKit = {
  ...base,
  Document: ({ lead }) => <p className="text-[13px] leading-5 text-foreground">{lead}</p>,
  taskMark: ({ task }) =>
    task.id === "t-switches" ? (
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Open the thread on Borrow two switches from ITaP">
        <Outbox className="size-3.5 text-muted-foreground" />
      </Button>
    ) : null,
  threads: { ...base.threads!, Mark: () => null },
  threadFacts: () =>
    new Map([
      ["p-lan", { mark: <Outbox className="size-3.5 text-muted-foreground" />, words: "1 mail to send", open: () => {} }],
      ["p-tryouts", { mark: <StatusMark state="working" word={false} />, words: "Working", open: () => {} }],
    ]),
  log: () => [
    { id: "th-ask", at: FIXTURE_NOW - 2 * HOUR, mark: <Outbox className="size-3.5" />, title: "Ask ITaP for two switches", detail: "1 mail to send", open: () => {} },
    { id: "th-seat", at: FIXTURE_NOW - 3 * HOUR, mark: <StatusMark state="done" word={false} />, title: "Seat map for 64", detail: "Made Seat map, changed Run of show", open: () => {} },
  ],
  files: () => [
    { id: "f-seat", itemId: "i-seats", name: "Seat map", kind: "sheet", by: "Made by Seat map for 64", at: FIXTURE_NOW - 3 * HOUR, open: () => {} },
    { id: "f-run", itemId: "i-run", name: "Run of show", kind: "doc", by: "Changed by Seat map for 64", at: FIXTURE_NOW - 3 * HOUR, open: () => {} },
  ],
};

export function ProjectsPreview({
  screen = "list",
  width = 1120,
  height = 720,
  threads = false,
  loading = false,
}: {
  screen?: keyof typeof PLACES;
  width?: number;
  height?: number;
  /** The thread slots filled, as M7 fills them. */
  threads?: boolean;
  /** The reads held: the bones. */
  loading?: boolean;
}) {
  const [client] = useState(() => {
    const made = fakeProjectsClient({ now: FIXTURE_NOW });
    if (loading) made.hold();
    return made;
  });
  const [place, setPlace] = useState<ProjectsPlace>(PLACES[screen]!);
  return (
    <div className="relative flex flex-col overflow-hidden rounded-lg border border-border bg-background" style={{ width, height }}>
      <div className="@container/viewhead flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-[13px]">
        <Project className="size-3.5 text-muted-foreground" />
        <BarTitle />
        <span className="flex-1" />
        <BarControls />
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <ProjectsKitProvider kit={threads ? filled : kit}>
          <ProjectsClientProvider client={client}>
            <div className="tc-projects h-full min-h-0">
              <Projects sector="purdue" place={place} onPlace={setPlace} />
            </div>
          </ProjectsClientProvider>
        </ProjectsKitProvider>
      </div>
    </div>
  );
}
