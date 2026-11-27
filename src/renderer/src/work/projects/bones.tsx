import { Bone, Bones } from "../../components/bones";

/**
 * Projects' bones, in the shape of what lands (docs/DESIGN.md "Loading and empty states";
 * docs/agents/loading-bones.md): the list's rows, or a project's or a task's page where the workspace's kept place is
 * one. Drawn by the view while its session is on its way, and by the frame while the view's chunk is
 * (`WorkViewDef.bones`), so this file holds no work-kit: the screens are written out here from sample words, in the
 * type and the boxes the kit's screens land in, and Skullet measures them. The measures are the kit's as projects.css
 * sets them (`--pk-row-h` 32px, `--pk-text` 13px, `--pk-title` 18/26, `--pk-list-column`, `--pk-page-column`),
 * named here, since the frame draws these before that stylesheet loads. The place is read from storage, as place.ts
 * keeps it.
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

/** The list's rows: a project's name, its next task with its due day, how much is done, and its target. */
export const SAMPLE_PROJECT_ROWS: readonly { id: string; name: string; next: string; done: string; target: string }[] = [
  { id: "sample:spring-invitational", name: "Spring invitational", next: "Book the arena seating", done: "4 of 9", target: "Apr 12" },
  { id: "sample:tryouts", name: "Varsity tryouts", next: "Send the schedule to coaches", done: "2 of 6", target: "Mar 3" },
  { id: "sample:lights", name: "Stream lights refresh", next: "Order the key lights", done: "1 of 4", target: "May 1" },
  { id: "sample:budget", name: "Next year's budget", next: "Draft the hardware line", done: "0 of 5", target: "Jun 30" },
];

/** A project's page: its name, the facts line, two lines of brief, then Plan's rows (a task under a task sits in). */
export const SAMPLE_PROJECT_PAGE = {
  name: "Spring invitational at the arena",
  facts: "Active · 4 of 9 done · Target Apr 12",
  brief: ["Two days of open play and the bracket finals in the arena, with the varsity team running the stage.", "Seats, power and the stream booked by March."],
  plan: [
    { id: "sample:seating", title: "Book the arena seating", under: false },
    { id: "sample:floor", title: "Confirm the floor plan", under: true },
    { id: "sample:power", title: "Ask facilities about power drops", under: false },
    { id: "sample:stream", title: "Test the stream from the stage", under: false },
  ],
} as const;

/** A task's page: its title, the place line, its fields, two lines of notes. */
export const SAMPLE_TASK_PAGE = {
  title: "Book the arena seating",
  place: "Spring invitational · PUR-24",
  fields: ["In progress", "Due Mar 1", "High"],
  notes: ["Two hundred seats on the floor, the rest in the stands; facilities need the count a week ahead.", "Ask about the risers."],
} as const;

export function ProjectsBones({ shape }: { shape: BonesShape }) {
  const label = shape === "project" ? "Loading the project" : shape === "task" ? "Loading the task" : "Loading Projects";
  return (
    // The frame names the wait; the bones inside it say nothing more (an empty label).
    <div role="status" aria-label={label} aria-busy data-projects-bones={shape} className="flex h-full min-h-0 flex-col">
      <Bones label="">{shape === "project" ? <ProjectPage /> : shape === "task" ? <TaskPage /> : <ListRows />}</Bones>
    </div>
  );
}

/** The list as the tracker's rows (work-kit's `ProjectFactsTable`): one line a row from a 56rem list with the column
 *  names over it, else two (the name and the target, then the facts). The column names are known at once. */
function ListRows() {
  const wide = "@4xl/pk:grid-cols-[minmax(0,1.3fr)_minmax(0,1.4fr)_minmax(0,1fr)_4.5rem_4.5rem] @4xl/pk:gap-x-6";
  return (
    <div className="@container/pk mx-auto w-full max-w-[64rem] px-2 pt-4 text-[13px] leading-5">
      <div skullet-own="" className={`hidden h-8 items-center px-4 text-xs text-muted-foreground @4xl/pk:grid ${wide}`}>
        <span className="col-start-2">Next</span>
        <span>Waiting on</span>
        <span>Done</span>
        <span>Target</span>
      </div>
      {SAMPLE_PROJECT_ROWS.map((row) => (
        <div key={row.id} className={`mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-2 py-1.5 @4xl/pk:h-8 @4xl/pk:py-0 ${wide}`}>
          <span className="min-w-0 truncate">{row.name}</span>
          <span className="col-start-2 row-start-1 text-muted-foreground tabular-nums @4xl/pk:col-start-5">{row.target}</span>
          <span className="col-span-2 flex min-w-0 gap-1 text-xs text-muted-foreground @4xl/pk:contents @4xl/pk:text-[13px] @4xl/pk:text-foreground">
            <span className="min-w-0 truncate @4xl/pk:col-start-2 @4xl/pk:row-start-1">{row.next}</span>
            <span className="shrink-0 tabular-nums @4xl/pk:col-start-4 @4xl/pk:row-start-1 @4xl/pk:text-muted-foreground">{row.done}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** A project's page in the kit's page column: the title at 18/26, the facts line, the brief, then Plan's rows. */
function ProjectPage() {
  const page = SAMPLE_PROJECT_PAGE;
  return (
    <div className="mx-auto flex w-full max-w-[44rem] flex-col">
      <div className="flex flex-col gap-2 px-4 pt-8">
        <p className="text-lg leading-[26px] font-semibold tracking-[-0.01em]">{page.name}</p>
        <p className="text-xs text-muted-foreground">{page.facts}</p>
        <div className="mt-3 flex flex-col text-[13px] leading-5">
          {page.brief.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </div>
      <div className="flex flex-col pt-8">
        <p skullet-own="" className="mx-4 mb-2 flex h-6 items-center text-xs font-medium text-muted-foreground">
          Plan
        </p>
        {page.plan.map((task) => (
          <div key={task.id} className="mx-2 flex h-8 items-center gap-2 px-2 text-[13px] leading-5" style={{ paddingInlineStart: task.under ? 36 : 8 }}>
            <Bone className="size-3.5 rounded-full" />
            <span className="min-w-0 truncate">{task.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A task's page: its title, the place line, its fields as the kit's 28px pickers, two lines of notes. */
function TaskPage() {
  const task = SAMPLE_TASK_PAGE;
  return (
    <div className="mx-auto flex w-full max-w-[45rem] flex-col gap-3 px-10 pt-8">
      <p className="text-lg leading-[26px] font-semibold tracking-[-0.01em]">{task.title}</p>
      <p className="text-xs text-muted-foreground">{task.place}</p>
      <div className="flex gap-2">
        {task.fields.map((field) => (
          <span key={field} className="flex h-7 items-center rounded-md px-2 text-xs">
            {field}
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-col text-[13px] leading-5">
        {task.notes.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </div>
  );
}
