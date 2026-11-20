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
 * its foot (`offer`), and the same mail with none (`plain`). Rendered by
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
const OFFER: GrantOffer = { id: "go_1", workspaceId: "ws", kind: "mail.send", label: "Mail to Dana Lee", routineId: null, from: SENT[0]!.ref, count: 5, createdAt: at(20, 9, 41) };

type State = "offer" | "plain";
let state: State = "offer";
let ready = false;

const answers = (method: string, params: { show?: string } = {}): unknown => {
  switch (method) {
    case "workspace.list":
      return [WS];
    case "project.list":
      return [];
    case "work.outbox.list":
      return params.show === "decided" ? { items: SENT } : { items: [], waiting: 0 };
    case "work.outbox.grants":
      return { grants: [] };
    case "work.outbox.offers":
      return { offers: state === "offer" ? [OFFER] : [] };
    case "work.outbox.results":
      return { results: [] };
    case "work.outbox.get":
      return SENT[0];
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

export function OutboxPreview({ state: s = "offer" }: { state?: State }) {
  if (!ready) {
    ready = true;
    state = s;
    resetOutboxStore();
    setWorkOn("local", true);
    rememberOutboxTab("sent");
  }
  return (
    <div className="flex h-[640px] w-full">
      <OutboxView besideRail onClose={() => {}} />
    </div>
  );
}
