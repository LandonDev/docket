import type { GrantOffer, OutboxGrant, OutboxItem } from "@shared/contract-work-outbox";
import { useEffect } from "react";
import { registry, type Link } from "../../lib/connection";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { setWorkOn } from "../../lib/workSwitch";
import { ACT_VIEWS } from "../acts/registry";
import { defineChunk } from "../../lib/lazyChunk";
import { asGivenComputer, OverFrame, Unsettled, usePressNamed } from "../kit.preview";
import { OutboxView, rememberOutboxTab } from "./OutboxView";
import { sessionStore } from "../../lib/tcserver/store";
import { resetOutboxStore, wantOutboxItem } from "./store";

/**
 * The Outbox over one fixed host, for `bun run ui:preview
 * src/renderer/src/work/outbox/Outbox.preview.tsx#OutboxPreview --props '{"state":"offer"}'`:
 * Sent with the mail whose press completed a run and the grant it earned at
 * its foot (`offer`), the same mail with none (`plain`), Waiting with an
 * agent's changes to shared files held for his press (`edits`), and Sent with
 * mail LifeOS has not yet said went (`queued`: queued twelve minutes on, sent,
 * back in drafts). Also: `empty` (nothing waits), `failed` (the day with the send that failed picked: Not sent
 * leads, its reason once in the detail), `day` (a day of held work in Waiting's order: Not sent, Starts soon, each
 * thread's group with the roster's fold, Scheduled; the reply to Dana picked, with its sentence and notes),
 * `ticked` (the roster's Select 6: the summary list), `results` (its Send 6, one row refused), `changed` (Show
 * changes open), `editing` (Edit in place), `stale` (an out-of-date change: Discard and Ask the thread again),
 * `scheduled` (a mail he timed: Cancel send and Send now), `done` (Done by day, with a discard's words, a put-away
 * out-of-date change and a phone's press), `loading` (the list's and the detail's bones), `grants` (the grants sheet over Sent), `kinds` (Waiting with a held item of six kinds; `pick` 0 is the
 * mail, 1 an invite, 5 a payload that could not be read, 6 a reply whose event LifeOS did not read; the calendar acts' LifeOS session did not answer), `kindsSilent` (the same, the host silent on its LifeOS status: the acts name it, with Retry), `longGuest` (`kinds` with `pick` 1: the invite, opened, with a guest whose long name and long address wrap in the column), `given` (Sent from a computer whose key may not grant) and `loadingAct` (Sent while the mail's own view loads).
 * Rendered by nothing in the app.
 */

const WS = { id: "ws", name: "Purdue Esports", path: "/home/work/Purdue Esports", kind: "work", sector: "purdue", createdAt: 1 };
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

const sent = (n: number, subject: string, text: string, when: number): OutboxItem => ({
  ref: { at: "lifeos", table: "outbox", id: `ob_${n}` },
  kind: "mail.send",
  workspaceId: "ws",
  sessionId: "t1",
  sector: "purdue",
  summary: `Send to Dana Lee: ${subject}`,
  verb: "Send",
  account: null,
  state: "sent",
  payload: {
    id: `ob_${n}`,
    status: "draft",
    message: { kind: "mail", accountId: "acct", to: [{ name: "Dana Lee", address: "dana.lee@purdue.edu" }], cc: [], bcc: [], subject, html: "", text, from: { address: "landon@purdue.edu" } },
  },
  createdAt: when - 60_000,
  decidedBy: "owner",
  decidedAt: when,
  n,
  why: "lifeos",
  grantId: null,
  error: null,
  result: { summary: `Sent to Dana Lee: ${subject}` },
  routineRunId: null,
  updatedAt: when,
});

/** A second job, so Sent shows its groups: a calendar change for refereeing. */
const WS2 = { id: "ws2", name: "Refereeing", path: "/home/work/Refereeing", kind: "work", sector: "ref", createdAt: 2 };
const SENT: OutboxItem[] = [
  sent(5, "Budget lines for the Spring LAN", "Hi Dana,\n\nThe Spring LAN comes to $4,180: $2,600 for the ballroom, $1,100 for prizes and $480 for food. The PO request is attached.\n\nLandon", at(20, 9, 41)),
  { ...sent(9, "", "", at(20, 8, 15)), ref: { at: "lifeos", table: "outbox", id: "ob_9" }, kind: "calendar.op", workspaceId: "ws2", sector: "ref", summary: "Add Varsity at North on Fri, Nov 27 at 6:00 PM", verb: "Add", payload: { id: "op9", kind: "create", payload: { title: "Varsity at North", startsAt: at(27, 18), endsAt: at(27, 20), location: "North High School" } }, result: null },
  sent(4, "Re: Travel for nationals", "Hi Dana,\n\nSix players and two staff, leaving Thursday at 7 AM. The van is booked through RecWell.\n\nLandon", at(19, 16, 5)),
  sent(3, "Re: Jersey order", "Hi Dana,\n\nThe order is 14 jerseys at $62 each. Invoice attached.\n\nLandon", at(18, 11, 20)),
];
/** An agent's change to a file others can open, as the host holds it (office.edit, google.edit). */
const edit = (n: number, kind: "office.edit" | "google.edit", summary: string, verb: string, payload: unknown, when: number): OutboxItem => ({
  ...sent(n, "", "", when),
  ref: { at: "host", id: `h_${n}` },
  kind,
  summary,
  verb,
  account: kind === "google.edit" ? "landon@purdue.edu" : null,
  state: "held",
  payload,
  decidedBy: null,
  decidedAt: null,
  why: "pillar",
  result: null,
});
const EDITS = [
  edit(
    8,
    "office.edit",
    'Make the change in Spring LAN budget.docx: "$4,180" to "$4,320, with $140 more for prizes"',
    "Make the change",
    { host: "local", app: "word", key: "/Users/landon/Library/CloudStorage/OneDrive-Purdue/Spring LAN budget.docx", name: "Spring LAN budget.docx", edit: { find: "The Spring LAN comes to $4,180", replace: "The Spring LAN comes to $4,320, with $140 more for prizes" }, places: 1, base: "x" },
    at(20, 10, 12),
  ),
  edit(
    7,
    "google.edit",
    'Make 2 changes in Nationals travel: "7 AM" to "6:30 AM" and 1 more',
    "Make 2 changes",
    {
      app: "slides",
      account: "landon@purdue.edu",
      fileId: "1AbC",
      name: "Nationals travel",
      edits: [
        { find: "Thursday at 7 AM", replace: "Thursday at 6:30 AM", boxes: 1, on: [2] },
        { shape: "t4", text: "Six players, two staff, one van", slide: 3, was: "Six players and two staff" },
      ],
      revisionId: "r1",
    },
    at(20, 9, 58),
  ),
  edit(
    6,
    "office.edit",
    'Make the change in Jersey order.docx: add at the end: "Sizes still to confirm: two players."',
    "Make the change",
    { host: "local", app: "word", key: "https://purdue0.sharepoint.com/sites/esports/Jersey order.docx", name: "Jersey order.docx", edit: { insert: "Sizes still to confirm: two players.", at: "end" }, places: 0, base: "x" },
    at(20, 9, 30),
  ),
  edit(
    5,
    "google.edit",
    'Make the change in Travel plan: "7 AM" to "6:45 AM"',
    "Make the change",
    {
      app: "doc",
      account: "landon@purdue.edu",
      fileId: "1DoC",
      name: "Travel plan",
      edits: [{ find: "at 7 AM", replace: "at 6:45 AM", within: "Lunch is on the team card. The bus leaves the CoRec at 7 AM from the north doors. Bring IDs." }],
      revisionId: "r2",
    },
    at(20, 9, 10),
  ),
];

/** What LifeOS said of each sent mail, for `queued`: the newest still queued twelve minutes on, one sent, one taken back. */
const SAID: Partial<OutboxItem>[] = [{ lifeos: "queued", decidedAt: Date.now() - 12 * 60_000 }, {}, { lifeos: "confirmed" }, { lifeos: "drafts" }];
const sentList = (): OutboxItem[] => (state === "queued" ? SENT.map((item, i) => ({ ...item, ...SAID[i] })) : SENT);

const OFFER: GrantOffer = { id: "go_1", workspaceId: "ws", kind: "mail.send", label: "Mail to dana.lee@purdue.edu from landon@purdue.edu", routineId: null, from: SENT[0]!.ref, count: 5, createdAt: at(20, 9, 41) };


/** One held item of each of six kinds, as the Waiting list shows them; the last one's payload is not one its kind reads. */
const held = (n: number, kind: OutboxItem["kind"], summary: string, verb: string, payload: unknown, minutes: number): OutboxItem => ({ ...sent(n, "", "", at(20, 10, minutes)), kind, summary, verb, state: "held", payload, decidedBy: null, decidedAt: null, why: "pillar", result: null });
const INVITE = { id: "op22", kind: "create", payload: { title: "Spring LAN walkthrough", startsAt: at(27, 13), endsAt: at(27, 14), location: "North Ballroom", attendees: [{ address: "dana.lee@purdue.edu", name: "Dana Lee" }] } };
const KINDS: OutboxItem[] = [
  { ...SENT[0]!, state: "held", decidedBy: null, decidedAt: null, result: null, n: 21, createdAt: at(20, 10, 50) },
  held(22, "calendar.op", "Add Spring LAN walkthrough on Fri, Nov 27 at 1:00 PM", "Add", INVITE, 44),
  held(23, "chat.reply", "Reply to Sam Ortiz in Teams: Thursday at 7 works for varsity", "Reply", { chatId: "c1", source: "teams", chat: "Sam Ortiz", text: "Thursday at 7 works for varsity." }, 38),
  held(24, "file.act", "Move Risk assessment.docx to Esports Staff › Events", "Move", { verb: "move", name: "Risk assessment.docx" }, 31),
  held(25, "share.guestLink", "Share Spring LAN run of show with Maya Chen to comment", "Share", { name: "Maya Chen", role: "comment" }, 20),
  held(26, "teams.post", "Post in Esports Staff › General: the bus leaves at 6:30 AM", "Post", "not a payload", 12),
  held(27, "calendar.op", "Answer Kickoff call with Northside PT: Yes", "Send", { id: "op27", kind: "accept", eventId: "ev_call", account: "landon@purdue.edu" }, 6),
];
/** `longGuest`: the invite asks one more guest, whose name and address are each longer than a narrow column. */
const LONG_GUEST = { address: "events-and-facilities-reservations.recwell@purdue.edu", name: "Alexandra Montgomery-Fitzgerald" };
const LONG_KINDS: OutboxItem[] = KINDS.map((k) => (k.payload === INVITE ? { ...k, payload: { ...INVITE, payload: { ...INVITE.payload, attendees: [...INVITE.payload.attendees, LONG_GUEST] } } } : k));
const GRANTS: OutboxGrant[] = [
  { id: "g1", workspaceId: "ws", kind: "mail.send", matcher: {}, label: "Mail to dana.lee@purdue.edu from landon@purdue.edu", madeFrom: SENT[0]!.ref, routineId: null, createdAt: at(12, 9), removedAt: null },
  { id: "g2", workspaceId: "ws", kind: "calendar.op", matcher: {}, label: "Changes to events on the Esports calendar", madeFrom: SENT[1]!.ref, routineId: "r1", createdAt: at(15, 16), removedAt: null },
];

/**
 * A day of held work, for the rebuilt Waiting (`day` and the states over it): a send that failed, an invite that
 * starts this afternoon, a thread's run of roster mails past its fold, a reply to Dana the thread rewrote and Dana
 * wrote back to, a Slack reply, a change to a shared sheet that went out of date, and a mail he timed for tomorrow.
 */
const H = 3_600_000;
const NOW = Date.now();
const TITLES: Record<string, string> = { roster: "Nationals roster", budget: "Travel budget for nationals", release: "Release 2.14", bugs: "Weekly bug report", sweep: "Morning sweep" };
const mailTo = (n: number, to: string, address: string, subject: string, text: string, over: Partial<OutboxItem> = {}): OutboxItem => ({
  ...sent(n, subject, text, NOW - (30 - n) * 60_000),
  ref: { at: "lifeos", table: "outbox", id: `d_${n}` },
  summary: `Send to ${to}: ${subject}`,
  state: "held",
  decidedBy: null,
  decidedAt: null,
  result: null,
  later: true,
  effect: `Goes from landon@purdue.edu to ${to} after your 30-second undo.`,
  payload: { id: `d_${n}`, status: "draft", message: { kind: "mail", accountId: "acct", to: [{ name: to, address }], cc: [], bcc: [], subject, html: "", text, from: { address: "landon@purdue.edu" } } },
  ...over,
});
const PLAYERS = ["Alex Kim", "Jordan Patel", "Riley Chen", "Morgan Diaz", "Casey Wu", "Taylor Brooks"];
const ROSTER = PLAYERS.map((p, i) =>
  mailTo(i + 1, p, `${p.split(" ")[0]!.toLowerCase()}@purdue.edu`, "Nationals travel, confirm by Friday", `${p.split(" ")[0]},\n\nYou're on the roster for nationals in Columbus, Dec 4 to 6. The bus leaves the Armory at 7:00 AM on the 4th.\n\nReply by Friday to confirm.\n\nLandon`, { sessionId: "roster" }),
);
const DANA = mailTo(10, "Dana Lee", "dana.lee@purdue.edu", "Re: Nationals budget", "Dana,\n\nNumbers are in the sheet: $16,294 against the $16,500 budget, with 8% held back for hotels.\n\nCan you sign off before Friday?\n\nLandon", {
  sessionId: "budget",
  summary: "Reply to Dana Lee: Re: Nationals budget",
  verb: "Reply",
  changed: { at: NOW - 20 * 60_000, by: "thread" },
});
const DANA_FIRST = { message: { from: { address: "landon@purdue.edu" }, to: [{ name: "Dana Lee", address: "dana.lee@purdue.edu" }], subject: "Re: Nationals budget", text: "Dana,\n\nNumbers are in the sheet: $16,534 against the $16,500 budget.\n\nCan you sign off before Friday?\n\nLandon" } };
const DAY: OutboxItem[] = [
  ...ROSTER,
  DANA,
  { ...held(11, "chat.reply", "Reply to Priya in #release: Ship 2.14 tonight after QA signs off", "Reply", { chatId: "c1", source: "slack", chat: "#release", text: "Yes, ship tonight once QA signs off. I'll watch the crash dashboard for the first hour." }, 0), workspaceId: "ws2", sector: "ref", sessionId: "release", createdAt: NOW - 9 * 60_000, effect: "Replies as you in Priya's thread in #release, where 31 people see it.", later: true },
  { ...mailTo(12, "Priya", "priya@cosmicgames.com", "Bug report, week 47", "Priya,\n\n41 new, 37 closed, 9 still open from last week.\n\nLandon", { sessionId: "bugs", routineRunId: "run1", workspaceId: "ws2", sector: "ref" }), state: "failed", error: "Gmail refused it: the attachment is over 25 MB." },
  { ...held(13, "calendar.op", "Accept Kickoff call with Northside PT", "Accept", { id: "op13", kind: "accept", eventId: "ev1", eventStartsAt: NOW + 4 * H, account: "landon@purdue.edu" }, 0), sessionId: "sweep", createdAt: NOW - 2 * H, effect: "Tells Northside PT you will come and keeps it on your Purdue calendar." },
  { ...EDITS[0]!, sessionId: "budget", state: "stale", error: "Dana changed the Hotels sheet at 9:05 AM, after this was made.", createdAt: NOW - 50 * 60_000 },
  { ...mailTo(14, "Jess", "jess@hypixel.net", "Trailer cut, v3", "Jess,\n\nThe v3 cut is up.\n\nLandon", { sessionId: "release", workspaceId: "ws2", sector: "ref" }), state: "scheduled", scheduledFor: NOW + 22 * H, scheduledZone: "America/Chicago" },
];
/** Done for `done`: what went, what he discarded with his words, and what went out of date that he put away. */
const DONE: OutboxItem[] = [
  { ...SENT[0]!, decidedAt: NOW - 40 * 60_000, decidedBy: "owner", via: "outbox" },
  { ...mailTo(15, "Sam Ortiz", "sortiz@purdue.edu", "Scrim schedule", "Sam,\n\nTuesday works.\n\nLandon"), state: "discarded", decidedBy: "owner", decidedAt: NOW - 70 * 60_000, reason: "Already booked the lab for Tuesday." },
  { ...EDITS[1]!, state: "stale", dismissedAt: NOW - 26 * H, error: "Slide 5 moved after it was made." },
  { ...SENT[2]!, decidedAt: NOW - 27 * H, decidedBy: "owner:remote", via: "phone" },
];

type State =
  | "offer"
  | "plain"
  | "edits"
  | "queued"
  | "empty"
  | "failed"
  | "grants"
  | "kinds"
  | "kindsSilent"
  | "longGuest"
  | "given"
  | "loadingAct"
  | "day"
  | "ticked"
  | "results"
  | "changed"
  | "editing"
  | "stale"
  | "scheduled"
  | "done"
  | "loading";
/** The states drawn over the day's Waiting, and the item each picks. */
const DAY_PICK: Partial<Record<State, string>> = { day: "d_10", ticked: "d_10", results: "d_10", changed: "d_10", editing: "d_10", stale: "h_8", scheduled: "d_14", failed: "d_12" };

// Each kind draws its act in a chunk of its own: landed before the first render, as a warm window draws them.
await Promise.all(Object.values(ACT_VIEWS).map((view) => view.chunk?.load()));
let state: State = "offer";
/** `kinds`, or `kindsSilent`: the same held items, the host silent on its LifeOS status. */
const kinds = (): boolean => state === "kinds" || state === "kindsSilent" || state === "longGuest";
/** Which held change shows in the detail (the oldest waiting item is the one selected): 0 a Word replace, 1 a deck's two changes, 2 a Word insert, 3 a Doc's replace. */
let pick = 0;
/** The oldest waiting item is the one selected: the picked kind is made the oldest. */
const pickedKinds = (): OutboxItem[] => (state === "longGuest" ? LONG_KINDS : KINDS).map((k, i) => (i === pick ? { ...k, createdAt: at(20, 8) } : k));
const waitingEdits = (): OutboxItem[] => EDITS.map((e, i) => (i === pick ? { ...e, createdAt: at(20, 8) } : e));
let ready = false;

const onDay = (): boolean => DAY_PICK[state] !== undefined;
const dayItems = (): OutboxItem[] => DAY.map((i) => (i.ref.id === DAY_PICK[state] ? { ...i } : i));
const answers = (method: string, params: { show?: string; ref?: { id: string }; items?: { ref: { id: string }; do: string }[] } = {}): unknown => {
  switch (method) {
    case "workspace.list":
      return [WS, WS2];
    case "project.list":
      return [];
    case "work.outbox.list":
      if (state === "loading") return new Promise(() => {});
      if (params.show === "done") return { items: state === "empty" ? [] : state === "done" ? DONE : sentList() };
      if (onDay()) return { items: dayItems(), waiting: DAY.length - 1 };
      if (kinds()) return { items: pickedKinds(), waiting: KINDS.length };
      return state === "edits" ? { items: waitingEdits(), waiting: EDITS.length } : { items: [], waiting: 0 };
    case "work.outbox.grants":
      return { grants: state === "grants" ? GRANTS : [] };
    case "work.outbox.offers":
      return { offers: state === "offer" || state === "given" ? [OFFER] : [] };
    case "work.outbox.results":
      return { results: [] };
    case "work.lifeos.status":
      // The held calendar acts read LifeOS: in `kinds` its session did not answer, so their details say so once, with Retry.
      if (state === "kinds" || state === "longGuest") return { lifeos: { state: "unreachable", since: at(20, 9, 58), error: "timed out" }, keys: [] };
      // In `kindsSilent` the host itself never answers its status: the acts' details name it, with Retry.
      if (state === "kindsSilent") throw Object.assign(new Error("No answer in 15 s"), { name: "TimeoutError" });
      break;
    case "work.outbox.decide":
      // One row the host refuses, the rest go: what the summary's results look like.
      return {
        results: params.items!.map((d) => {
          const item = DAY.find((i) => i.ref.id === d.ref.id)!;
          return d.ref.id === "d_3" ? { ref: item.ref, ok: false, error: "Outlook did not answer in time" } : { ref: item.ref, ok: true, item: { ...item, state: "sent", lifeos: "queued", decidedAt: NOW } };
        }),
      };
    case "work.outbox.get": {
      if (onDay()) {
        const item = DAY.find((i) => i.ref.id === params.ref?.id) ?? DAY[0]!;
        return item === DANA ? { ...DANA, changed: { ...DANA.changed!, first: DANA_FIRST }, replied: { from: "Dana Lee", at: NOW - 12 * 60_000, line: "Can you add the hotel line before you send?" } } : item;
      }
      if (state === "done") return DONE.find((i) => i.ref.id === params.ref?.id) ?? DONE[0];
      return kinds() ? pickedKinds()[pick] : state === "edits" ? waitingEdits()[pick] : sentList()[pick];
    }
  }
  throw new Error(`no ${method}`);
};

const link = {
  environmentId: "local",
  profile: "local",
  connected: true,
  onOpen: () => () => {},
  onClose: () => () => {},
  onPush: () => () => {},
  request<T>(method: string, params?: { show?: string }): Promise<T> {
    try {
      return Promise.resolve(answers(method, params as never) as T);
    } catch (err) {
      return Promise.reject(err);
    }
  },
} as unknown as Link;
Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });
workspaceStore.reset();
workspaceStore.attach(link);

// The threads' titles, as the session store would hold them.
Object.assign(sessionStore, { metaOf: (id: string) => (TITLES[id] ? ({ id, title: TITLES[id] } as never) : null) });

export function OutboxPreview({ state: s = "offer", pick: p = 0 }: { state?: State; pick?: number }) {
  if (!ready) {
    ready = true;
    state = s;
    pick = p;
    resetOutboxStore();
    setWorkOn("local", true);
    if (s === "given") asGivenComputer({ on: ["local"] });
    // The host the acts read through, named as the app names it.
    if (s === "kindsSilent") Object.assign(registry, { environment: (id: string) => ({ id, name: "The box" }) });
    // A mail's own view still on its way: the bones it shows until then.
    if (s === "loadingAct") ACT_VIEWS["mail.send"] = { kind: "mail.send", chunk: defineChunk("preview-never", () => new Promise(() => {})) };
    rememberOutboxTab(s === "edits" || s === "kinds" || s === "kindsSilent" || s === "longGuest" || s === "empty" || s === "failed" || s === "loading" || DAY_PICK[s] ? "waiting" : "done");
    if (DAY_PICK[s]) wantOutboxItem(`local:${s === "stale" ? "host" : "lifeos"}:${DAY_PICK[s]}`);
  }
  // Each state's own press, once the page has drawn: the thread's Select 6, its Send 6, Show changes, Edit.
  usePressNamed(s === "ticked" || s === "results" ? "Select 6" : s === "changed" ? "Show changes" : s === "editing" ? "Edit" : null, 160);
  usePressNamed(s === "results" ? "Send 6" : null, 300);
  // Grants is the header's own press.
  usePressNamed(s === "grants" ? "Grants" : null, 80);
  // `longGuest` opens the picked row, so a narrow window shows its detail in the list's place.
  useEffect(() => {
    if (s !== "longGuest") return;
    const t = setTimeout(() => document.querySelector<HTMLElement>('button[aria-current="true"]')?.click(), 120);
    return () => clearTimeout(t);
  }, [s]);
  return (
    <OverFrame maxWidth={1100} height={640}>
      {s === "results" ? <Unsettled ms={900} /> : null}
      <div className="flex h-full w-full">
        <OutboxView besideRail onClose={() => {}} />
      </div>
    </OverFrame>
  );
}
