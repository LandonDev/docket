import type { ReactNode } from "react";
import { clashTitle, type Clash, type ClashSide } from "@shared/work/clashes";
import { AgendaWeek, type ViewsKit, ViewsKitProvider } from "work-kit/views";
import { X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { EventRow } from "../agenda/AgendaView";
import type { AgendaEvent } from "../tasks/client";
import { Empty, Events, StepForm } from "./ClashDialog";

/**
 * Clashes, still, for `bun run ui:preview
 * src/renderer/src/work/clashes/Clash.preview.tsx#ClashDialogPreview --props '{"state":"overlap"}'`
 * (`overlap`, `drive`, `about`, `plain`, `decline`, `propose`, `move`,
 * `sending`, `refused`, `cleared`, `loading`, `gone`) and `#ClashRowsPreview` (a day of
 * the Agenda with a clash on two rows, a leave-by, and a row with none) and
 * `#ClashWeekPreview` (the Week with the clash's two events marked). The
 * dialog's own box, head and foot stand around the real parts, since a dialog
 * draws in a portal a static page cannot hold. Rendered by nothing in the app.
 */

// The static page's DOM has no animations to list; the week's scroller asks for them.
if (typeof Element !== "undefined" && !Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

const noop = (): void => {};
const HOUR = 3_600_000;
/** Thursday, 26 November 2026, 1:00 PM on this machine's clock. */
const T0 = new Date(2026, 10, 26, 13, 0).getTime();

const side = (eventId: string, sector: ClashSide["sector"], title: string, startH: number, hours: number, more: Partial<ClashSide> = {}): ClashSide => ({
  eventId,
  sector,
  title,
  startsAt: T0 + startH * HOUR,
  endsAt: T0 + (startH + hours) * HOUR,
  can: [],
  ...more,
});
const meeting = side("ev_meeting", "purdue", "Staff meeting", 3, 2, { place: "Cedar Hall, 4 Elm St, Cedar Falls, IN", can: ["decline", "propose"] });
const game = side("ev_game", "ref", "Varsity Basketball", 4.5, 2, { place: "Maple Ridge High School, 12 Oak St, Riverton, IN 47906, United States", workspaceId: "ws_ref", can: ["decline", "late"] });
const dinner = side("ev_dinner", "life", "Dinner with the Okafors", 7, 1.5, { place: "Juniper Table, 88 Canal St, Riverton, IN", can: ["move"] });

const CLASHES: Record<string, Clash> = {
  overlap: { id: "a-b", kind: "overlap", a: meeting, b: game, minutes: 38, miles: 24, measured: true },
  drive: { id: "b-c", kind: "drive", a: game, b: dinner, minutes: 44, miles: 31, measured: true, shortBy: 14 },
  about: {
    id: "a-c",
    kind: "drive",
    a: { ...meeting, rough: "town", place: "Cedar Falls, IN", location: "Cedar Hall, Cedar Falls, IN", startsAt: T0 + 4.5 * HOUR, endsAt: T0 + 6.5 * HOUR },
    b: dinner,
    minutes: 41,
    miles: 25,
    measured: false,
    shortBy: 12,
  },
  plain: { id: "a-d", kind: "overlap", a: { ...meeting, place: undefined, can: [] }, b: side("ev_call", "cosmic", "Release review", 4, 1, { can: [] }) },
};

/** The dialog's box, as `chrome/Modal` draws it at `sm`: title, the day under it, the close, then the body. */
function Box({ title, day, children }: { title: string; day?: string | undefined; children: ReactNode }) {
  return (
    <div className="flex w-[448px] flex-col overflow-hidden rounded-2xl bg-popover text-sm leading-[22px] text-popover-foreground shadow-overlay ring-1 ring-border">
      <header className="flex shrink-0 items-start gap-2 px-5 pt-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-6 tracking-[-0.01em]">{title}</h2>
          {day ? <p className="mt-1 truncate text-xs text-muted-foreground">{day}</p> : null}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" className="-me-1 -mt-0.5 text-muted-foreground">
          <X />
        </Button>
      </header>
      {/* The Modal's own body rule: a foot with no body keeps the title 16px off its hairline. */}
      <div className="flex flex-col [&>[data-slot=dialog-footer]:first-child]:mt-4">{children}</div>
    </div>
  );
}

export function ClashDialogPreview({ state = "overlap" }: { state?: string }) {
  const day = "Thursday, November 26";
  if (state === "loading" || state === "gone") {
    return (
      <Box title={state === "gone" ? "No longer a clash" : "Clash"}>
        <Empty state={state === "gone" ? "gone" : "loading"} onClose={noop} />
      </Box>
    );
  }
  const step = state === "decline" || state === "propose" || state === "sending" || state === "refused" || state === "cleared" ? ("a" as const) : state === "move" ? ("b" as const) : null;
  if (step) {
    const clash = state === "move" ? CLASHES.drive! : CLASHES.overlap!;
    // The cleared step is a proposal's: its sentence runs to two lines, which the step keeps when the words turn.
    const way = state === "move" ? "move" : state === "propose" || state === "cleared" ? "propose" : "decline";
    return (
      <Box title={state === "cleared" ? "No longer a clash" : clashTitle(clash)} day={day}>
        <StepForm clash={clash} step={{ side: step, way }} cleared={state === "cleared"} pending={state === "sending"} refused={state === "refused" ? "This calendar's Google account must be connected again before LifeOS may write to it." : null} onBack={noop} onSend={noop} />
      </Box>
    );
  }
  const clash = CLASHES[state] ?? CLASHES.overlap!;
  return (
    <Box title={clashTitle(clash)} day={day}>
      <Events clash={clash} pending={false} busy={null} error={null} onClose={noop} onFine={noop} onWay={noop} />
    </Box>
  );
}

const row = (s: ClashSide, more: Partial<AgendaEvent> = {}): AgendaEvent => ({ _id: s.eventId, title: s.title, sector: s.sector, startsAt: s.startsAt, endsAt: s.endsAt, allDay: false, location: s.place?.split(",")[0], ...more }) as AgendaEvent;

/** A day of the Agenda's list: a clash said on both its events, a drive that is short, a leave-by, and a row with nothing to say. */
export function ClashRowsPreview() {
  const rows: { event: AgendaEvent; clashes?: Clash[]; leave?: number }[] = [
    { event: row(side("ev_stand", "purdue", "Stand-up", 1, 0.5)) },
    { event: row(meeting), clashes: [CLASHES.overlap!] },
    { event: row(game), clashes: [CLASHES.overlap!, CLASHES.drive!], leave: game.startsAt - 68 * 60_000 },
    { event: row(dinner), clashes: [CLASHES.drive!], leave: dinner.startsAt - 44 * 60_000 },
  ];
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 bg-background px-6 py-6">
      <section aria-label="Today" className="flex flex-col">
        <h2 className="mb-1 px-3 text-xs font-medium text-muted-foreground">Today</h2>
        {rows.map(({ event, clashes, leave }) => (
          <EventRow key={event._id} event={event} past={false} leave={leave} clashes={clashes} day={T0} onPrepare={noop} people={[]} workspaceId="ws" environmentId="box" />
        ))}
      </section>
    </div>
  );
}

/** What the shared week draws with here, as the Agenda gives it: no sector dot, no faces. */
const kit: ViewsKit = { SectorMark: () => null, Face: () => null, openTask: noop };

/** The Agenda's Week with the two events of a clash marked: work-kit's dot before each title. */
export function ClashWeekPreview() {
  // Morning hours, so the still page shows them without a scroll.
  const at = (s: ClashSide, startH: number, hours: number) => row({ ...s, startsAt: T0 + startH * HOUR, endsAt: T0 + (startH + hours) * HOUR });
  const events = [at(side("ev_stand", "purdue", "Stand-up", 0, 0), -11.5, 0.75), at(meeting, -6, 2), at(game, -5, 2), at(side("ev_review", "purdue", "Budget review", 0, 0), 19.5, 1.5)];
  return (
    <ViewsKitProvider kit={kit}>
      <div className="wk-calendar h-[560px] w-[820px] bg-background px-6 pt-2 pb-6">
        <AgendaWeek events={events} day={T0} weekStart={0} onOpen={noop} onCreate={noop} marked={new Set(["ev_meeting", "ev_game"])} />
      </div>
    </ViewsKitProvider>
  );
}

