// A preview page for `bun run ui:preview src/renderer/src/work/tasks/TasksView.preview.tsx#TasksPreview --props '{"state":"list"}'`:
// the Tasks view under its header, over a LifeOS that answers from made-up tasks. States: `list` (the lead, This
// week, Later, Waiting), `long` (a long title and project), `loading`, `empty`, `sheet` (a task's sheet open), `done`
// (a done task chosen in Work Search: its sheet read by its id, only reading) and
// `new` (New task), and `unanswered` (the box's link is open but its LifeOS status ask went unanswered: the frame's
// line with Retry, nothing pulsing under it). Rendered by nothing in the app.
import { keepPlace } from "../shell/place";
import { openWorkView } from "../../lib/workSwitch";
import { boxSilent, JOB, standUpView, usePress, ViewAt } from "../kit.preview";

type State = "list" | "long" | "loading" | "empty" | "sheet" | "done" | "new" | "unanswered";

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const task = (id: string, title: string, over: Record<string, unknown> = {}) => ({ _id: id, _creationTime: NOW - 4 * DAY, title, sector: "purdue", status: "todo", ...over });

const TASKS = [
  task("t1", "Book the ballroom for the Spring LAN", { projectId: "p1", dueAt: NOW + 2 * HOUR }),
  task("t2", "Send Dana Lee the budget", { dueAt: NOW + 2 * DAY }),
  task("t3", "Order the prize headsets", { projectId: "p1", dueAt: NOW + 4 * DAY }),
  task("t4", "Confirm the bus for nationals", { dueAt: NOW - DAY }),
  task("t5", "Draft the fall recruiting post", { dueAt: NOW + 16 * DAY }),
  task("t6", "Approve the scrim schedule", { status: "waiting", waitingOn: "Sam Ortiz" }),
  task("t7", "Signed venue form", { status: "waiting", waitingOn: "Dana Lee", dueAt: NOW + 3 * DAY }),
];
const LONG = [
  task("t1", "Book the North and South Ballrooms in the Memorial Union for both days of the Spring LAN, with power to every table", { projectId: "p2", dueAt: NOW + 2 * HOUR }),
  ...TASKS.slice(1),
];
const PROJECTS = [
  { _id: "p1", name: "Spring LAN", sector: "purdue" },
  { _id: "p2", name: "Purdue Esports Club Operations: Spring LAN 2027 planning", sector: "purdue" },
];
const DETAIL = { task: { ...TASKS[5], description: "Sam is checking the lab hours with RecWell before he signs off. Ask again Thursday if nothing has come." } };
const DONE = { task: task("d1", "Print the brackets for the fall cup", { status: "done", projectId: "p1", dueAt: NOW - 3 * DAY, description: "Forty copies, double sided, at the union print shop." }) };

let ready = false;

export function TasksPreview({ state = "list" }: { state?: State }) {
  if (!ready) {
    ready = true;
    const rows = state === "loading" ? undefined : state === "empty" ? [] : state === "long" ? LONG : TASKS;
    standUpView("tasks", { "tasks:list": rows, "projects:list": PROJECTS, "tasks:get": (args) => (args.id === "d1" ? DONE : DETAIL), "workLinks:byEntity": [] });
    // The visit opens on the sheet the workspace kept.
    if (state === "sheet") keepPlace(JOB.id, "tasks", { task: "t6" });
    // Work Search's Return on a done task: the view asked for it by id.
    if (state === "done") openWorkView({ workspaceId: JOB.id, view: "tasks", task: "d1" });
    // The box's link is open, so the host is not away: it only did not answer. No New task over a page that cannot hold its dialog.
    if (state === "unanswered") boxSilent();
  }
  // New task is the header's own press.
  usePress(state === "new" ? "[data-view-heading] ~ button" : null, 80);
  return <ViewAt view="tasks" height={state === "sheet" || state === "done" || state === "new" ? 640 : 560} />;
}
