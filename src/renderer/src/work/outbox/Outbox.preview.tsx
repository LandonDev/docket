import type { GrantOffer, OutboxGrant, OutboxItem } from "@shared/contract-work-outbox";
import { registry, type Link } from "../../lib/connection";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { setWorkOn } from "../../lib/workSwitch";
import { ACT_VIEWS } from "../acts/registry";
import { defineChunk } from "../../lib/lazyChunk";
import { asGivenComputer, OverFrame, usePressNamed } from "../kit.preview";
import { OutboxView, rememberOutboxTab } from "./OutboxView";
import { resetOutboxStore } from "./store";

/**
 * The Outbox over one fixed host, for `bun run ui:preview
 * src/renderer/src/work/outbox/Outbox.preview.tsx#OutboxPreview --props '{"state":"offer"}'`:
 * Sent with the mail whose press completed a run and the grant it earned at
 * its foot (`offer`), the same mail with none (`plain`), Waiting with an
 * agent's changes to shared files held for his press (`edits`), and Sent with
 * mail LifeOS has not yet said went (`queued`: queued twelve minutes on, sent,
 * back in drafts). Also: `empty` (nothing waits), `failed` (Waiting with a send that failed, its reason in
 * the row and the detail), `grants` (the grants sheet over Sent), `kinds` (Waiting with a held item of six kinds; `pick` 0 is the
 * mail, 1 an invite, 5 a payload that could not be read, 6 a reply whose event LifeOS did not read; the calendar acts' LifeOS session did not answer), `given` (Sent from a computer whose key may not grant) and `loadingAct` (Sent while the mail's own view loads).
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

/** A send that failed, with the reason the host gave. */
const FAILED: OutboxItem = { ...sent(6, "Re: Ballroom deposit", "Hi Dana,\n\nThe deposit form is attached.\n\nLandon", at(20, 11, 2)), state: "failed", error: "LifeOS refused the send: the attachment is over 25 MB", result: null };

/** One held item of each of six kinds, as the Waiting list shows them; the last one's payload is not one its kind reads. */
const held = (n: number, kind: OutboxItem["kind"], summary: string, verb: string, payload: unknown, minutes: number): OutboxItem => ({ ...sent(n, "", "", at(20, 10, minutes)), kind, summary, verb, state: "held", payload, decidedBy: null, decidedAt: null, why: "pillar", result: null });
const KINDS: OutboxItem[] = [
  { ...SENT[0]!, state: "held", decidedBy: null, decidedAt: null, result: null, n: 21, createdAt: at(20, 10, 50) },
  held(22, "calendar.op", "Add Spring LAN walkthrough on Fri, Nov 27 at 1:00 PM", "Add", { id: "op22", kind: "create", payload: { title: "Spring LAN walkthrough", startsAt: at(27, 13), endsAt: at(27, 14), location: "North Ballroom", attendees: [{ address: "dana.lee@purdue.edu", name: "Dana Lee" }] } }, 44),
  held(23, "chat.reply", "Reply to Sam Ortiz in Teams: Thursday at 7 works for varsity", "Reply", { chatId: "c1", text: "Thursday at 7 works for varsity." }, 38),
  held(24, "file.act", "Move Risk assessment.docx to Esports Staff › Events", "Move", { verb: "move", name: "Risk assessment.docx" }, 31),
  held(25, "share.guestLink", "Share Spring LAN run of show with Maya Chen to comment", "Share", { name: "Maya Chen", role: "comment" }, 20),
  held(26, "teams.post", "Post in Esports Staff › General: the bus leaves at 6:30 AM", "Post", "not a payload", 12),
  held(27, "calendar.op", "Answer Kickoff call with Northside PT: Yes", "Send", { id: "op27", kind: "accept", eventId: "ev_call", account: "landon@purdue.edu" }, 6),
];
const GRANTS: OutboxGrant[] = [
  { id: "g1", workspaceId: "ws", kind: "mail.send", matcher: {}, label: "Mail to dana.lee@purdue.edu from landon@purdue.edu", madeFrom: SENT[0]!.ref, routineId: null, createdAt: at(12, 9), removedAt: null },
  { id: "g2", workspaceId: "ws", kind: "calendar.op", matcher: {}, label: "Changes to events on the Esports calendar", madeFrom: SENT[1]!.ref, routineId: "r1", createdAt: at(15, 16), removedAt: null },
];

type State = "offer" | "plain" | "edits" | "queued" | "empty" | "failed" | "grants" | "kinds" | "given" | "loadingAct";

// Each kind draws its act in a chunk of its own: landed before the first render, as a warm window draws them.
await Promise.all(Object.values(ACT_VIEWS).map((view) => view.chunk?.load()));
let state: State = "offer";
/** Which held change shows in the detail (the oldest waiting item is the one selected): 0 a Word replace, 1 a deck's two changes, 2 a Word insert, 3 a Doc's replace. */
let pick = 0;
/** The oldest waiting item is the one selected: the picked kind is made the oldest. */
const pickedKinds = (): OutboxItem[] => KINDS.map((k, i) => (i === pick ? { ...k, createdAt: at(20, 8) } : k));
const waitingEdits = (): OutboxItem[] => EDITS.map((e, i) => (i === pick ? { ...e, createdAt: at(20, 8) } : e));
let ready = false;

const answers = (method: string, params: { show?: string } = {}): unknown => {
  switch (method) {
    case "workspace.list":
      return [WS, WS2];
    case "project.list":
      return [];
    case "work.outbox.list":
      if (params.show === "decided") return { items: state === "empty" ? [] : sentList() };
      if (state === "kinds") return { items: pickedKinds(), waiting: KINDS.length };
      if (state === "failed") return { items: [FAILED], waiting: 1 };
      return state === "edits" ? { items: waitingEdits(), waiting: EDITS.length } : { items: [], waiting: 0 };
    case "work.outbox.grants":
      return { grants: state === "grants" ? GRANTS : [] };
    case "work.outbox.offers":
      return { offers: state === "offer" || state === "given" ? [OFFER] : [] };
    case "work.outbox.results":
      return { results: [] };
    case "work.lifeos.status":
      // The held calendar acts read LifeOS: in `kinds` its session did not answer, so their details say so once, with Retry.
      if (state === "kinds") return { lifeos: { state: "unreachable", since: at(20, 9, 58), error: "timed out" }, keys: [] };
      break;
    case "work.outbox.get":
      return state === "failed" ? FAILED : state === "kinds" ? pickedKinds()[pick] : state === "edits" ? waitingEdits()[pick] : sentList()[pick];
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
      return Promise.resolve(answers(method, params) as T);
    } catch (err) {
      return Promise.reject(err);
    }
  },
} as unknown as Link;
Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });
workspaceStore.reset();
workspaceStore.attach(link);

export function OutboxPreview({ state: s = "offer", pick: p = 0 }: { state?: State; pick?: number }) {
  if (!ready) {
    ready = true;
    state = s;
    pick = p;
    resetOutboxStore();
    setWorkOn("local", true);
    if (s === "given") asGivenComputer({ on: ["local"] });
    // A mail's own view still on its way: the bones it shows until then.
    if (s === "loadingAct") ACT_VIEWS["mail.send"] = { kind: "mail.send", chunk: defineChunk("preview-never", () => new Promise(() => {})) };
    rememberOutboxTab(s === "edits" || s === "kinds" || s === "empty" || s === "failed" ? "waiting" : "sent");
  }
  // Grants is the header's own press.
  usePressNamed(s === "grants" ? "Grants" : null, 80);
  return (
    <OverFrame maxWidth={1100} height={640}>
      <div className="flex h-full w-full">
        <OutboxView besideRail onClose={() => {}} />
      </div>
    </OverFrame>
  );
}
