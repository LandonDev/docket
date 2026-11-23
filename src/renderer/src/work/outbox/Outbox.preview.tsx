import type { GrantOffer, OutboxItem } from "@shared/contract-work-outbox";
import { registry, type Link } from "../../lib/connection";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { setWorkOn } from "../../lib/workSwitch";
import { OutboxView, rememberOutboxTab } from "./OutboxView";
import { resetOutboxStore } from "./store";

/**
 * The Outbox over one fixed host, for `bun run ui:preview
 * src/renderer/src/work/outbox/Outbox.preview.tsx#OutboxPreview --props '{"state":"offer"}'`:
 * Sent with the mail whose press completed a run and the grant it earned at
 * its foot (`offer`), the same mail with none (`plain`), and Waiting with an
 * agent's changes to shared files held for his press (`edits`). Rendered by
 * nothing in the app.
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

const SENT = [
  sent(5, "Budget lines for the Spring LAN", "Hi Dana,\n\nThe Spring LAN comes to $4,180: $2,600 for the ballroom, $1,100 for prizes and $480 for food. The PO request is attached.\n\nLandon", at(20, 9, 41)),
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
    'Make the change in Jersey order.docx: add "Sizes still to confirm: two players." at its end',
    "Make the change",
    { host: "local", app: "word", key: "https://purdue0.sharepoint.com/sites/esports/Jersey order.docx", name: "Jersey order.docx", edit: { insert: "Sizes still to confirm: two players.", at: "end" }, places: 0, base: "x" },
    at(20, 9, 30),
  ),
];

const OFFER: GrantOffer = { id: "go_1", workspaceId: "ws", kind: "mail.send", label: "Mail to dana.lee@purdue.edu from landon@purdue.edu", routineId: null, from: SENT[0]!.ref, count: 5, createdAt: at(20, 9, 41) };

type State = "offer" | "plain" | "edits";
let state: State = "offer";
/** Which held change shows in the detail (the oldest waiting item is the one selected): 0 a Word replace, 1 a deck's two changes, 2 a Word insert. */
let pick = 0;
const waitingEdits = (): OutboxItem[] => EDITS.map((e, i) => (i === pick ? { ...e, createdAt: at(20, 8) } : e));
let ready = false;

const answers = (method: string, params: { show?: string } = {}): unknown => {
  switch (method) {
    case "workspace.list":
      return [WS];
    case "project.list":
      return [];
    case "work.outbox.list":
      if (params.show === "decided") return { items: SENT };
      return state === "edits" ? { items: waitingEdits(), waiting: EDITS.length } : { items: [], waiting: 0 };
    case "work.outbox.grants":
      return { grants: [] };
    case "work.outbox.offers":
      return { offers: state === "offer" ? [OFFER] : [] };
    case "work.outbox.results":
      return { results: [] };
    case "work.outbox.get":
      return state === "edits" ? waitingEdits()[pick] : SENT[0];
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
    rememberOutboxTab(s === "edits" ? "waiting" : "sent");
  }
  return (
    <div className="flex h-[640px] w-full">
      <OutboxView besideRail onClose={() => {}} />
    </div>
  );
}
