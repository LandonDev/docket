import type { DigestDay, DigestSettings } from "@shared/contract-work-digest";
import type { TellRow } from "@shared/work/tell";
import { registry, type Link } from "../../lib/connection";
import { setWorkOn } from "../../lib/workSwitch";
import { DIGEST_BODY, DIGEST_WIDTH, DigestList } from "./DigestSheet";
import { mergeDays, mergeRows, resetDigestStore, seedDigestHost } from "./store";
import { SettingsSection } from "./SettingsSection";

/**
 * The digest's surfaces, still, for `bun run ui:preview
 * src/renderer/src/work/digest/Digest.preview.tsx#DigestSheetPreview --props
 * '{"state":"full"}'` (also `empty`, `hostDown`, `loading`) and
 * `#DigestSettingsPreview` (`default`, `changed`, `failed`, `loading`).
 * The sheet's own box and head are drawn around the real list, since a
 * sheet draws in a portal a static page cannot hold. Made-up rows; rendered
 * by nothing in the app.
 */

const at = (day: number, h: number, m = 0): number => new Date(2026, 10, day, h, m).getTime();
const NOW = at(24, 13, 55);

let n = 0;
const row = (over: Partial<TellRow>): TellRow => ({ id: `t${++n}`, host: "box", kind: "routines.done", group: "results", workspaceId: "ws", sector: "cosmic", title: "", at: at(24, 7), how: "digest", day: "2026-11-24", toldAt: null, ...over });

const ROWS: TellRow[] = [
  // since the digest
  row({ day: null, how: "waiting", sector: "ref", group: "results", title: "2 receipts to confirm", detail: "Game fees, Saturday", at: at(24, 9, 40), open: { view: "tasks", workspaceId: "ws" } }),
  row({ day: null, how: "now", toldAt: at(24, 13, 50), sector: "purdue", group: "meetings", title: "Budget review starts at 2:00 PM", detail: "With Dana Reyes", at: at(24, 13, 50), by: at(24, 14), open: { view: "prep", workspaceId: "ws", at: "ev1" } }),
  // today's digest
  row({ sector: "cosmic", title: "Morning summary", detail: "Done in 12m", at: at(24, 7, 2), open: { thread: "t1" } }),
  row({ sector: "cosmic", group: "held", title: "Held: Send to Marcus Hale: Re: season pass copy", at: at(23, 16, 20), open: { held: { at: "host", id: "h1" } } }),
  row({ sector: "hypixel", group: "review", title: "This week's review is ready", at: at(24, 6, 0), open: { place: "review" } }),
  row({ sector: "purdue", group: "held", title: "Held: Invite Dana Reyes to Spring LAN walkthrough", at: at(23, 15, 5), by: at(26, 14), open: { held: { at: "lifeos", table: "calendarOps", id: "op1" } } }),
  row({ sector: "purdue", group: "people", title: "3 sent mails have no answer", detail: "The oldest is 6 days old", at: at(24, 8), open: { view: "mail", workspaceId: "ws" } }),
  row({ sector: "ref", group: "clashes", title: "Varsity at North overlaps JV at East", detail: "Thursday, 6:00 PM", at: at(23, 20, 10), open: { view: "agenda", workspaceId: "ws", at: "ev2" } }),
  row({ sector: null, workspaceId: null, group: "ending", title: "Sign-in to Frame.io ends Dec 8", at: at(24, 6, 30), open: { settings: "connections" } }),
  // yesterday's
  row({ day: "2026-11-23", sector: "cosmic", title: "Morning summary", detail: "Done in 9m", at: at(23, 7, 1), open: { thread: "t2" } }),
  row({ day: "2026-11-23", sector: "unify", group: "people", title: "Dana Reyes edited Pricing notes", at: at(22, 21, 14), open: { view: "docs", workspaceId: "ws" } }),
  row({ day: "2026-11-23", sector: "cosmic", title: "Nightly crash triage", detail: "Failed: the sign-in to the tracker lapsed", at: at(23, 2, 30), open: { thread: "t3" } }),
  // an earlier day
  row({ day: "2026-11-20", sector: "purdue", group: "system", title: "4 captures to sort", at: at(20, 7, 55) }),
];
const DAYS: DigestDay[] = [
  { day: "2026-11-24", madeAt: at(24, 8), seenAt: at(24, 8, 5), count: 7 },
  { day: "2026-11-23", madeAt: at(23, 8), seenAt: at(23, 9), count: 3 },
  { day: "2026-11-20", madeAt: at(20, 8), seenAt: at(20, 8, 30), count: 1 },
];

type SheetState = "full" | "empty" | "hostDown" | "loading";

export function DigestSheetPreview({ state = "full" }: { state?: SheetState }) {
  const has = state === "full" || state === "hostDown";
  const view = { days: has ? mergeDays([{ environmentId: "box", days: DAYS }]) : [], rows: has ? mergeRows([ROWS]) : [], loaded: state !== "loading" };
  return (
    <div className="flex min-h-[480px] flex-col overflow-hidden rounded-2xl bg-popover text-sm text-popover-foreground shadow-overlay ring-1 ring-border" style={{ width: DIGEST_WIDTH }}>
      <div className="flex flex-col gap-1 p-5 pe-12">
        <h2 className="text-base leading-6 font-semibold tracking-[-0.01em] text-foreground">Digest</h2>
      </div>
      <div className={DIGEST_BODY}>
        <DigestList view={view} now={NOW} unanswered={state === "hostDown" ? "The Mac did not answer" : ""} onOpenRow={() => {}} onRetry={() => {}} />
      </div>
    </div>
  );
}

type SettingsState = "default" | "changed" | "failed" | "loading";
const SETTINGS: DigestSettings = { at: "08:00", zone: "America/Chicago", levels: {}, nextAt: at(25, 8) };
let seeded: SettingsState | null = null;

const link = {
  environmentId: "local",
  profile: "local",
  connected: true,
  onOpen: () => () => {},
  onClose: () => () => {},
  onPush: () => () => {},
  // Never answers: the page shows what was seeded.
  request: () => new Promise(() => {}),
} as unknown as Link;

export function DigestSettingsPreview({ state = "default" }: { state?: SettingsState }) {
  if (seeded !== state) {
    seeded = state;
    Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });
    resetDigestStore();
    setWorkOn("local", true);
    if (state === "loading") seedDigestHost("local", { loaded: false });
    else if (state === "failed") seedDigestHost("local", { settings: null, error: "The Mac did not answer" });
    else seedDigestHost("local", { settings: state === "changed" ? { ...SETTINGS, at: "07:30", levels: { held: "now", results: "digest" } } : SETTINGS });
  }
  return (
    <div className="@container/page w-[624px]">
      <SettingsSection />
    </div>
  );
}
