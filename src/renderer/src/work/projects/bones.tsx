import { Skeleton } from "../../components/ui/skeleton";

/**
 * Projects' bones, in the shape of what lands (docs/DESIGN.md "Loading and empty states"): the list's rows, or a
 * project's or a task's page where the workspace's kept place is one. Drawn by the view while its session is on its
 * way, and by the frame while the view's chunk is (`WorkViewDef.bones`), so this file holds no work-kit: the place is
 * read from storage, as place.ts keeps it. The columns are the kit's (`--pk-list-column`, `--pk-page-column` in
 * projects.css), named here, since the frame draws these before that stylesheet loads.
 */

/** Where place.ts keeps every workspace's place (`work.projects.place.v1`). */
export const PLACE_KEY = "work.projects.place.v1";

export type BonesShape = "list" | "project" | "task";

/** The shape a workspace's Projects will land in: its kept place's page, else the list. */
export function bonesShape(workspaceId: string): BonesShape {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(PLACE_KEY) ?? "{}") as Record<string, { at?: unknown; id?: unknown } | undefined>;
    const place = all?.[workspaceId];
    if (place && typeof place.id === "string" && (place.at === "project" || place.at === "task")) return place.at;
  } catch {
    /* a window with no storage, or one unreadable: the list */
  }
  return "list";
}

export function ProjectsBones({ shape }: { shape: BonesShape }) {
  if (shape === "project") return <ProjectBones />;
  if (shape === "task") return <TaskBones />;
  return <ListBones />;
}

/** The list: the tracker's rows, a name, its next task and a date. */
function ListBones() {
  return (
    <div aria-busy aria-label="Loading Projects" data-bones="list" className="mx-auto flex w-full max-w-[64rem] flex-col gap-1 px-6 pt-12">
      {["w-2/5", "w-1/3", "w-1/2", "w-1/4"].map((w) => (
        <div key={w} className="flex h-8 items-center gap-6">
          <span className="flex flex-[1.3]">
            <Skeleton className={`h-3 ${w}`} />
          </span>
          <span className="flex flex-[1.4]">
            <Skeleton className="h-3 w-3/5" />
          </span>
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

/** A project's page, as the kit's own bones draw it: the title, the facts line, two lines of brief, then Plan's rows. */
function ProjectBones() {
  return (
    <div aria-busy aria-label="Loading the project" data-bones="project" className="mx-auto flex w-full max-w-[44rem] flex-col">
      <div className="flex flex-col gap-2 px-4 pt-8">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-3 w-48" />
        <Skeleton className="mt-3 h-3.5 w-full" />
        <Skeleton className="h-3.5 w-3/4" />
      </div>
      <div className="flex flex-col pt-8">
        <div className="mx-4 mb-2 flex h-6 items-center">
          <Skeleton className="h-3 w-24" />
        </div>
        {[48, 36, 40, 28].map((width, at) => (
          <div key={at} className="mx-2 flex h-9 items-center gap-2 px-2" style={{ paddingInlineStart: at % 3 === 1 ? 36 : 8 }}>
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A task's page: its title, the place line, three fields, two lines of notes. */
function TaskBones() {
  return (
    <div aria-busy aria-label="Loading the task" data-bones="task" className="mx-auto flex w-full max-w-[45rem] flex-col gap-3 px-10 pt-8">
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-3.5 w-40" />
      <div className="flex gap-2">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-16" />
      </div>
      <Skeleton className="mt-2 h-3.5 w-full" />
      <Skeleton className="h-3.5 w-4/5" />
    </div>
  );
}
