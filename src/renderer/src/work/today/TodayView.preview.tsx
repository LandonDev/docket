import type { ComponentType } from "react";
import type { OutboxItem } from "@shared/contract-work-outbox";
import { File, X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { registry, type Link } from "../../lib/connection";
import { workPlaceRow } from "../../lib/workPlaces";
import { Calendar, Mail } from "../icons";
import type { HostItem } from "../outbox/store";
import { PlaceFrame } from "../places/WorkPlacePage";
import { HeldSheetBody } from "./HeldSheet";
import { page, type Fed, type Folds, type LifeosReach } from "./model";
import { TodayPageView } from "./TodayView";
import type { TodayAnswer, TodayRow, TodaySection, TodayWorkspace } from "./types";

/**
 * Today, still, for `bun run ui:preview
 * src/renderer/src/work/today/TodayView.preview.tsx#TodayPreview --shot`:
 * the place's frame around the real page, drawn from made-up rows through
 * the real model. Every name here is invented. Rendered by nothing in the app.
 */

const noop = (): void => {};
const glyph = (Glyph: ComponentType<{ className?: string }>): TodayRow["lead"] => ({ kind: "glyph", glyph: Glyph });
const tick: TodayRow["lead"] = { kind: "tick", label: "Mark done", run: async () => {} };
const row = (key: string, section: string, sector: TodayRow["sector"], title: string, more: Partial<TodayRow> = {}): TodayRow => ({ key, section, sector, title, open: noop, ...more });

const HELD: TodaySection = { id: "held", title: "Waiting on you", order: 10, empty: "Nothing waits on your press", fold: 5 };
const MEETINGS: TodaySection = { id: "meetings", title: "Meetings", order: 20, empty: "No meetings today", lifeos: true };
const DUE: TodaySection = { id: "due", title: "Due", order: 30, empty: "Nothing due today", fold: 7, lifeos: true };
const WAITING: TodaySection = { id: "waiting", title: "Waiting on others", order: 40, empty: "No one owes you a reply", fold: 5, lifeos: true };
const FILES: TodaySection = { id: "files", title: "Changed by others", order: 50, empty: "No one changed your files", fold: 5 };

const HELD_ROWS = [
  row("held:1", "held", "purdue", "Reply to Dana Reyes", { detail: "Spring budget, second draft", when: "7:42 AM", lead: glyph(Mail), at: 1 }),
  row("held:2", "held", "ref", "Accept Crew meeting", { detail: "Thu 6:30 PM, Harrison High School", when: "7:40 AM", lead: glyph(Calendar), at: 2 }),
  row("held:3", "held", "unify", "Send invoice 1042 to Northfield Parks", { detail: "November hosting", when: "Nov 22", lead: glyph(Mail), at: 3 }),
];
const MEETING_ROWS = [
  row("event:0", "meetings", "cosmic", "Standup", { when: "8:30 AM", past: true, at: 1 }),
  row("event:00", "meetings", "hypixel", "Render review", { when: "9:00 AM", past: true, at: 2 }),
  row("event:1", "meetings", "purdue", "Staff sync", { detail: "CoRec 2212, with Dana Reyes", when: "10:30 AM", whenLine: "in 25 min", at: 3, acts: [{ label: "Prepare", run: noop }] }),
  row("event:2", "meetings", "hypixel", "Thumbnail review", { detail: "Overlaps Staff sync", detailLate: true, when: "10:45 AM", at: 4, acts: [{ label: "Resolve", run: noop }, { label: "Prepare", run: noop }] }),
  row("event:3", "meetings", "ref", "JV basketball, Harrison at West Lafayette", { detail: "Harrison High School", when: "6:00 PM", whenLine: "Leave 5:10 PM", at: 5, acts: [{ label: "Prepare", run: noop }] }),
];
const DUE_ROWS = [
  row("task:1", "due", "ref", "Renew arbiter registration", { when: "Nov 21", late: true, lead: tick, at: 1, acts: [{ label: "Tomorrow", run: noop }] }),
  row("task:2", "due", "cosmic", "Post patch notes for 3.8", { lead: tick, at: 2, acts: [{ label: "Tomorrow", run: noop }] }),
  row("task:3", "due", "purdue", "Order jerseys for the spring roster", { when: "3:00 PM", lead: tick, at: 3, acts: [{ label: "Tomorrow", run: noop }] }),
  ...Array.from({ length: 8 }, (_, i) => row(`task:${i + 4}`, "due", (["life", "unify", "hypixel", "purdue"] as const)[i % 4]!, ["Book the dentist", "Send the hosting report", "Trim the trailer cut", "Confirm the spring bracket", "Renew the domain", "File mileage", "Reply to the sponsor", "Pick up the van keys"][i]!, { lead: tick, at: i + 4 })),
];
const WAITING_ROWS = [
  row("mail:1", "waiting", "purdue", "Marcus Bell", { detail: "Sponsor deck for the spring LAN", when: "6 days", at: 1, acts: [{ label: "Nudge", run: noop }, { label: "Dismiss", run: noop }] }),
  row("mail:2", "waiting", "hypixel", "Priya Nair and 2 more", { detail: "Render queue access", when: "3 days", at: 2, acts: [{ label: "Nudge", run: noop }, { label: "Dismiss", run: noop }] }),
];
const FILE_ROWS = [row("file:1", "files", "purdue", "FY27 budget.xlsx", { detail: "Dana Reyes", when: "Sun 9:14 PM", lead: glyph(File), at: 1 })];

const job = (environmentId: string, sector: TodayWorkspace["sector"], open = true): TodayWorkspace => ({ environmentId, workspaceId: `${environmentId}-${sector}`, sector, name: sector, path: `/w/${sector}`, open });
const JOBS = (["cosmic", "hypixel", "purdue", "ref", "unify", "life"] as const).map((sector) => job("box", sector));
const fed = (section: TodaySection, answer: TodayAnswer): Fed => ({ source: { id: section.id, section }, answer });

type State = "day" | "unfolded" | "bones" | "empty" | "hosts" | "lifeos-down" | "signed-out" | "clear" | "no-jobs" | "sheet";

const FULL = [fed(HELD, { rows: HELD_ROWS }), fed(MEETINGS, { rows: MEETING_ROWS }), fed(DUE, { rows: DUE_ROWS }), fed(WAITING, { rows: WAITING_ROWS }), fed(FILES, { rows: FILE_ROWS })];
const ALL_FOLDS: Folds = { more: new Set(["due"]), earlier: new Set(["meetings"]) };

function modelOf(state: State) {
  const opts = (lifeos: LifeosReach = "ok", jobs = JOBS, folds?: Folds) => ({ jobs, lifeos, ...(folds ? { folds } : {}) });
  switch (state) {
    case "day":
      return page(FULL, opts());
    case "unfolded":
      return page(FULL, opts("ok", JOBS, ALL_FOLDS));
    case "bones":
      return page([fed(HELD, { rows: HELD_ROWS }), fed(MEETINGS, { loading: true }), fed(DUE, { loading: true }), fed(WAITING, { loading: true }), fed(FILES, { loading: true })], opts("waiting"));
    case "empty":
      return page([fed(HELD, {}), fed(MEETINGS, { rows: MEETING_ROWS.slice(0, 2), note: "Nothing more today. Tomorrow starts at 9:00 AM with Staff sync." }), fed(DUE, {}), fed(WAITING, { rows: WAITING_ROWS }), fed(FILES, {})], opts());
    case "hosts":
      return page(
        [fed(HELD, { rows: HELD_ROWS.slice(0, 1), failed: [{ environmentId: "box", error: "It did not answer in time", retry: noop }] }), fed(MEETINGS, { rows: MEETING_ROWS.slice(2) }), fed(DUE, { rows: DUE_ROWS.slice(0, 3) }), fed(WAITING, {}), fed(FILES, {})],
        opts("ok", [...JOBS, job("mac", "purdue", false)]),
      );
    case "lifeos-down":
      return page(FULL, opts("unreachable"));
    case "signed-out":
      return page(FULL, opts("signed-out"));
    case "clear":
      return page([fed(HELD, {}), fed(MEETINGS, {}), fed(DUE, {}), fed(WAITING, {}), fed(FILES, {})], opts());
    case "no-jobs":
      return page(FULL, opts("ok", []));
    case "sheet":
      return page(FULL, opts());
  }
}

const HOSTS: Record<string, string> = { box: "The box", mac: "Mac" };

// ── the held sheet's body, as the Outbox's own detail draws it ─────────────

const HELD_MAIL: OutboxItem = {
  ref: { at: "lifeos", table: "outbox", id: "ob_1" },
  kind: "mail.send",
  workspaceId: "ws",
  sessionId: null,
  sector: "purdue",
  summary: "Reply to Dana Reyes: Spring budget, second draft",
  verb: "Send",
  account: null,
  state: "held",
  payload: {
    id: "ob_1",
    status: "draft",
    message: {
      kind: "mail",
      accountId: "acct",
      to: [{ name: "Dana Reyes", address: "dana.reyes@example.edu" }],
      cc: [],
      bcc: [],
      subject: "Re: Spring budget, second draft",
      html: "",
      text: "Hi Dana,\n\nThe second draft holds the ballroom at 2,600 and moves prizes to 1,100. Food stays at 480. The request form is attached.\n\nLandon",
      from: { address: "landon@example.edu" },
    },
  },
  createdAt: new Date(2026, 10, 23, 7, 42).getTime(),
  decidedBy: null,
  decidedAt: null,
  n: 12,
  why: "lifeos",
  grantId: null,
  error: null,
  result: null,
  routineRunId: null,
  updatedAt: new Date(2026, 10, 23, 7, 42).getTime(),
};
const link = {
  environmentId: "box",
  profile: "local",
  connected: true,
  onOpen: () => () => {},
  onClose: () => () => {},
  onPush: () => () => {},
  request: <T,>(method: string): Promise<T> => (method === "work.outbox.get" ? Promise.resolve(HELD_MAIL as T) : Promise.reject(new Error(`no ${method}`))),
} as unknown as Link;

export function TodayPreview({ state = "day" }: { state?: State }) {
  if (state === "sheet") {
    Object.assign(registry, { primary: () => link, linkOf: () => link });
    return (
      // The sheet's own box: 520px, the popover's fill and corners (components/ui/sheet.tsx).
      <div data-slot="sheet-content" className="flex h-[560px] w-[520px] max-w-full flex-col overflow-hidden rounded-2xl bg-popover text-sm text-popover-foreground shadow-overlay ring-1 ring-border">
        <HeldSheetBody
          item={{ ...HELD_MAIL, environmentId: "box" } as HostItem}
          at={0}
          count={3}
          workspace="Purdue Esports"
          host="The box"
          close={
            <Button variant="ghost" size="icon-sm" aria-label="Close" className="text-muted-foreground">
              <X />
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div className={`flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background ${state === "clear" || state === "no-jobs" ? "h-[360px]" : ""}`}>
      <PlaceFrame place="today" label="Today" icon={workPlaceRow("today")?.icon} head={<time className="text-xs tabular-nums text-muted-foreground">Mon, Nov 23</time>} besideRail onClose={noop}>
        <div className="flex min-h-0 flex-1 flex-col">
          <TodayPageView model={modelOf(state)} hostName={(id) => HOSTS[id] ?? "A host"} hasFiles onRetryLifeos={noop} />
        </div>
      </PlaceFrame>
    </div>
  );
}
