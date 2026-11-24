// A preview page for `bun run ui:preview src/renderer/src/work/shell/SessionPresses.preview.tsx#SessionPressesPreview
// --props '{"state":"signed-out","may":false}'`: the box's LifeOS sign-in missing (`signed-out`) or waiting for his
// approval (`pairing`), on a window that may sign the box in (`may`: the box's own window) and on one that may not
// (his laptop as a given computer). Readers of the one rule (lifeosDown.ts `useDownPress`): a view's frame, Today's
// line, a job read through that session on Today (`LostLine`), a held calendar act's details and the Settings LifeOS
// line. Rendered by nothing in the app.
import { registry } from "../../lib/connection";
import { LifeosLine } from "../connections/LifeosLine";
import { View as CalendarAct } from "../agenda/CalendarActView";
import { asGivenComputer, standUpView, ViewAt } from "../kit.preview";
import { TodayPageView } from "../today/TodayView";
import { setLifeosStatus } from "./lifeos";

type State = "signed-out" | "pairing";

const NOW = Date.now();
const OP = { id: "op1", kind: "update", eventId: "ev1", payload: { title: "Staff sync", startsAt: NOW + 3_600_000, endsAt: NOW + 7_200_000 } };

let ready = false;

export function SessionPressesPreview({ state = "signed-out", may = false }: { state?: State; may?: boolean }) {
  if (!ready) {
    ready = true;
    standUpView("tasks", {});
    if (may) Object.assign(registry, { environment: (id: string) => ({ id, name: "The box" }) });
    else asGivenComputer({ on: ["local"] });
    setLifeosStatus("local", { lifeos: state === "pairing" ? { state: "pairing", code: "QK4T-9MZD", expiresAt: NOW + 600_000 } : { state: "signed-out" }, keys: [] } as never);
  }
  return (
    <div className="flex w-full max-w-[864px] flex-col gap-4">
      <ViewAt view="tasks" height={200} />
      <div className="overflow-hidden rounded-lg border border-border bg-background py-2">
        <TodayPageView model={{ kind: "day", blocks: [{ kind: "lifeos", reach: state }], offline: [], keys: [] }} hostName={() => "The box"} lifeosHost="The box" lifeosEnv="local" onRetryLifeos={() => {}} />
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-background py-2">
        <TodayPageView model={{ kind: "day", blocks: [{ kind: "section", section: lost(state) }], offline: [], keys: [] }} hostName={() => "The box"} lifeosHost="The box" lifeosEnv="local" onRetryLifeos={() => {}} />
      </div>
      <div className="rounded-lg border border-border bg-background p-4">
        <CalendarAct item={{ kind: "calendar.op", payload: OP, sector: null } as never} env="local" />
      </div>
      <div className="rounded-lg border border-border bg-background px-4">
        <LifeosLine session={{ environmentId: "local", sector: null, client: null, state } as never} waiting={null} />
      </div>
    </div>
  );
}

/** Today's Tasks with one job read through the box's down session, the rows of the jobs that read above it (none here). */
const lost = (state: State) => ({
  id: "tasks",
  title: "Tasks",
  state: "rows" as const,
  pending: false,
  partial: false,
  empty: "Nothing due",
  earlier: 0,
  rows: [],
  more: 0,
  failed: [{ environmentId: "local", error: "", down: state, said: "Refereeing's tasks left out", retry: () => {} }],
  away: false,
});
