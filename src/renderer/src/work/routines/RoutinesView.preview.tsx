// A preview page for `bun run ui:preview src/renderer/src/work/routines/RoutinesView.preview.tsx#RoutinesPreview --props '{"state":"list"}'`:
// the Routines view under its header, over a host that answers from made-up routines. States: `list` (the list, the
// first routine's detail and its runs), `proposed` (an agent's proposal leads), `runs-failed`, `empty`, `failed`,
// `form` (New routine), `edit` (a routine's form) and `given` (a computer with a given key: no New routine, no
// presses that change a routine). Rendered by nothing in the app.
import type { RoutineRow, RoutineRun } from "@shared/contract-work-routines";
import { asGivenComputer, standUpView, usePress, usePressNamed, ViewAt } from "../kit.preview";

type State = "list" | "proposed" | "runs-failed" | "empty" | "failed" | "form" | "edit" | "given";

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const row = (over: Partial<RoutineRow>): RoutineRow =>
  ({
    id: "r1",
    workspaceId: "ws",
    projectId: null,
    kind: "routine",
    name: "Morning brief",
    prompt: "Read my Purdue mail and agenda, and list what needs me before 10.",
    playId: null,
    model: null,
    reasoning: null,
    trigger: { on: "schedule", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=0", tz: "America/Chicago" },
    words: "Weekdays at 7:00 AM",
    ends: { kind: "never" },
    enabled: true,
    proposed: false,
    resumeSessionId: null,
    madeIn: null,
    nextAt: NOW + 14 * HOUR,
    lastAt: NOW - 10 * HOUR,
    lastState: "held",
    lastWords: "Held 2",
    checkedAt: null,
    waiting: null,
    running: false,
    ended: false,
    createdBy: "owner",
    createdAt: 1,
    host: "local",
    ...over,
  }) as RoutineRow;

const ROUTINES: RoutineRow[] = [
  row({}),
  row({ id: "r2", name: "Sponsor mail watch", prompt: "When a sponsor writes, draft a reply and hold it.", trigger: { on: "lifeos", kinds: ["mail"], filter: { from: "sponsors" } }, words: "When mail comes from a sponsor", lastState: "quiet", lastWords: "Nothing to do", createdAt: 2 }),
  row({ id: "r3", name: "Friday week in review for Purdue Esports Club Operations", prompt: "Make the week's review.", words: "Fridays at 4:00 PM", enabled: false, lastState: "failed", lastWords: "Failed: LifeOS did not answer", createdAt: 3 }),
];
const PROPOSED = row({ id: "r0", name: "Nudge unanswered vendor mail", prompt: "Each Monday, list vendor mail with no answer in five days and draft a nudge.", words: "Mondays at 9:00 AM", proposed: true, createdBy: "model", lastAt: null, lastState: null, lastWords: null, createdAt: 0 });

const run = (n: number, ago: number, state: RoutineRun["state"], summary: string, cause = "Weekdays at 7:00 AM"): RoutineRun => ({ id: `run${n}`, routineId: "r1", sessionId: state === "skipped" ? null : `s${n}`, firedAt: NOW - ago, cause, folded: 0, state, summary });
const RUNS: RoutineRun[] = [run(1, 10 * HOUR, "held", "Held 2"), run(2, DAY + 10 * HOUR, "quiet", "Nothing to do"), run(3, 2 * DAY + 10 * HOUR, "failed", "Failed: LifeOS did not answer"), run(4, 3 * DAY + 10 * HOUR, "asked", "Asked you 1 question")];

let ready = false;

export function RoutinesPreview({ state = "list" }: { state?: State }) {
  if (!ready) {
    ready = true;
    if (state === "given") asGivenComputer({ on: ["local"] });
    const routines = state === "empty" ? [] : state === "proposed" ? [PROPOSED, ...ROUTINES] : ROUTINES;
    standUpView("routines", {}, (method) => {
      if (method === "work.routines.list") {
        if (state === "failed") throw new Error("The box did not answer");
        return { routines };
      }
      if (method === "work.routines.runs") {
        if (state === "runs-failed") throw new Error("The box did not answer");
        return { runs: RUNS };
      }
      if (method === "work.routines.plays") return { plays: [] };
      if (method === "work.outbox.rules") return { addons: [] };
      return undefined;
    });
  }
  // New routine is the header's own press; a routine's form is its Edit.
  usePress(state === "form" ? "[data-view-heading] ~ button" : null, 80);
  usePressNamed(state === "edit" ? "Edit" : null, 80);
  return <ViewAt view="routines" height={state === "form" || state === "edit" ? 720 : 560} />;
}
