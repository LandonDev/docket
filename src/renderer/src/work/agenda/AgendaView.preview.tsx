// A preview page for `bun run ui:preview src/renderer/src/work/agenda/AgendaView.preview.tsx#AgendaPreview --props '{"state":"list"}'`:
// the Agenda view under its header, over a LifeOS that answers from made-up events. States: `list` (the next days),
// `week`, `month`, `new` (New event over the list), `new-none` (New event where no calendar of the job takes events),
// `empty`, `loading`, `loading-week` (the Week kept, its grid's bones) and `week-ahead` (the Week two weeks on: off today's
// period, the narrow header keeps its Today press) and `unanswered` (the box's LifeOS status went unanswered: the
// frame's line with Retry, no New event over a page that cannot hold its dialog). Rendered by nothing in the app.
import { useEffect } from "react";
import { startOfDay } from "work-kit/views/lib/agenda";
import { keepPlace } from "../shell/place";
import { boxSilent, JOB, standUpView, ViewAt } from "../kit.preview";
import { agendaPlace, type AgendaShow } from "./place";

type State = AgendaShow | "new" | "new-none" | "empty" | "loading" | "loading-week" | "week-ahead" | "unanswered";

const TODAY = startOfDay(Date.now());
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (day: number, hour: number, minute = 0): number => TODAY + day * DAY + hour * HOUR + minute * 60_000;
const event = (id: string, title: string, startsAt: number, hours: number, location?: string) => ({ _id: id, title, sector: "purdue", startsAt, endsAt: startsAt + hours * HOUR, allDay: false, ...(location ? { location } : {}) });

const EVENTS = [
  event("e1", "Staff standup", at(0, 9), 0.5, "Teams"),
  event("e2", "Spring LAN walkthrough with Dana Lee and the Memorial Union events office", at(0, 13), 1, "North Ballroom, Purdue Memorial Union"),
  event("e3", "Varsity scrim: Rocket League", at(0, 18, 30), 2, "CoRec esports arena"),
  event("e4", "Budget review", at(1, 10), 1, "Room 204"),
  event("e5", "Captains meeting", at(1, 16), 1),
  { _id: "e6", title: "Spring LAN load-in", sector: "purdue", startsAt: at(3, 0), allDay: true },
  event("e7", "Recruiting table at the Involvement Fair", at(4, 11), 3, "Engineering Mall"),
  event("e8", "Nationals travel call", at(9, 15), 0.5, "Teams"),
];

let ready = false;

export function AgendaPreview({ state = "list" }: { state?: State }) {
  if (!ready) {
    ready = true;
    // The visit opens on the view the workspace kept: the state's own, on today.
    keepPlace(JOB.id, "agenda", { view: state === "week" || state === "month" ? state : state === "loading-week" || state === "week-ahead" ? "week" : "list", day: state === "week-ahead" ? TODAY + 14 * DAY : TODAY, on: TODAY });
    standUpView("agenda", { "events:range": state === "loading" || state === "loading-week" ? undefined : state === "empty" ? [] : EVENTS, "people:directory": [], "sources:list": state === "new-none" ? [] : [{ _id: "s1", kind: "gcal", account: "landon@purdue.edu", label: "landon@purdue.edu", sector: "purdue", enabled: true }] });
    if (state === "unanswered") boxSilent();
  }
  // New event is the header's own press: here the place it sets, once the visit has opened.
  useEffect(() => {
    if (state !== "new" && state !== "new-none") return;
    const t = setTimeout(() => agendaPlace.set({ ...agendaPlace.get(), adding: "now" }), 40);
    return () => clearTimeout(t);
  }, [state]);
  return <ViewAt view="agenda" height={state === "month" || state === "week" || state === "week-ahead" || state === "loading-week" || state === "new" || state === "new-none" ? 700 : 560} />;
}
