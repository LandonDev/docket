import { useState } from "react";
import { fakeProjectsClient, Projects, ProjectsClientProvider, ProjectsKitProvider, type ProjectsKit, type ProjectsPlace } from "work-kit/projects";
import "work-kit/projects/styles.css";
import "./projects.css";
import { MessageSquare } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
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

export function ProjectsPreview({ screen = "list", width = 1120, height = 720 }: { screen?: keyof typeof PLACES; width?: number; height?: number }) {
  const [client] = useState(() => fakeProjectsClient());
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
        <ProjectsKitProvider kit={kit}>
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
