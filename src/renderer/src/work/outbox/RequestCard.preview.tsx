import type { OutboxItem, OutboxRequest } from "@shared/contract-work-outbox";
import { registry, type Link } from "../../lib/connection";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { sessionStore } from "../../lib/tcserver/store";
import { setWorkOn } from "../../lib/workSwitch";
import { ACT_VIEWS } from "../acts/registry";
import { OverFrame, Unsettled } from "../kit.preview";
import { RequestCard } from "./RequestCard";

/**
 * A thread's request card over one fixed host, for `bun run ui:preview
 * src/renderer/src/work/outbox/RequestCard.preview.tsx#RequestPreview --props '{"state":"waiting"}'`:
 * `waiting` (three roster mails, one rewritten since the thread asked), `mixed` (two sends and a discard: Approve 3),
 * `done` (answered: one queued in LifeOS, one not sent, one left out), `page` (the Outbox's detail frame), `loading`
 * (the card while its request is read). Rendered by nothing in the app.
 */

type State = "waiting" | "mixed" | "done" | "page" | "loading";
let state: State = "waiting";
const NOW = Date.now();
const WS = { id: "ws1", name: "Purdue Esports", path: "/w", kind: "work", sector: "purdue", createdAt: 1 };

const mail = (id: string, to: string): OutboxItem => ({
  ref: { at: "lifeos", table: "outbox", id },
  kind: "mail.send",
  workspaceId: "ws1",
  sessionId: "t1",
  sector: "purdue",
  summary: `Send to ${to}: Nationals travel, confirm by Friday`,
  verb: "Send",
  account: "landon@purdue.edu",
  state: "held",
  payload: { message: { to: [{ name: to, address: `${to.split(" ")[0]!.toLowerCase()}@purdue.edu` }], subject: "Nationals travel, confirm by Friday", text: "Bus leaves the Armory at 7:00 AM.\n\nLandon", from: { address: "landon@purdue.edu" } } },
  effect: "Goes as your mail after your undo time.",
  createdAt: NOW - 3_600_000,
  decidedBy: null,
  decidedAt: null,
  n: null,
  why: "lifeos",
  grantId: null,
  error: null,
  result: null,
  routineRunId: null,
  updatedAt: NOW - 3_600_000,
});

const rows = (): OutboxRequest["rows"] => {
  const base: OutboxRequest["rows"] = [
    { ref: { at: "lifeos", table: "outbox", id: "m1" }, do: "send", item: mail("m1", "Alex Kim"), changed: false, open: true, receipt: "a" },
    { ref: { at: "lifeos", table: "outbox", id: "m2" }, do: state === "mixed" ? "discard" : "send", item: mail("m2", "Jordan Patel"), changed: false, open: true, receipt: "b" },
    { ref: { at: "lifeos", table: "outbox", id: "m3" }, do: "send", item: mail("m3", "Riley Chen"), changed: state !== "mixed", open: true, ...(state === "mixed" ? { receipt: "c" } : {}) },
  ];
  if (state !== "done") return base;
  return [
    { ...base[0]!, open: false, item: { ...base[0]!.item!, state: "sent", lifeos: "queued", decidedAt: NOW }, result: { ok: true, state: "sent" } },
    { ...base[1]!, result: { ok: false, error: "Outlook did not answer in time" } },
    base[2]!,
  ];
};

const request = (): OutboxRequest => ({
  id: "r1",
  n: 3,
  sessionId: "t1",
  workspaceId: "ws1",
  sector: "purdue",
  quote: "send the roster mails, all three",
  head: "Send 3 mails",
  state: state === "done" ? "answered" : "open",
  createdAt: NOW - 120_000,
  expiresAt: NOW + 86_400_000,
  answeredBy: state === "done" ? "owner" : null,
  answeredAt: state === "done" ? new Date(2026, 10, 24, 9, 41).getTime() : null,
  rows: rows(),
});

const answers = (method: string): unknown => {
  if (method === "workspace.list") return [WS];
  if (method === "project.list") return [];
  if (method === "work.outbox.request.get") return request();
  if (method === "work.outbox.requests") return { requests: [] };
  throw new Error(`no ${method}`);
};
const link = {
  environmentId: "local",
  profile: "local",
  connected: true,
  onOpen: () => () => {},
  onClose: () => () => {},
  onPush: () => () => {},
  request<T>(method: string): Promise<T> {
    // The request's read is out for as long as the page is looked at.
    if (state === "loading" && method === "work.outbox.request.get") return new Promise<T>(() => {});
    try {
      return Promise.resolve(answers(method) as T);
    } catch (err) {
      return Promise.reject(err);
    }
  },
} as unknown as Link;
Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });
Object.assign(sessionStore, { metaOf: (id: string) => (id === "t1" ? ({ id, title: "Nationals roster" } as never) : null) });
workspaceStore.reset();
workspaceStore.attach(link);
setWorkOn("local", true);
await Promise.all(Object.values(ACT_VIEWS).map((view) => view.chunk?.load()));

export function RequestPreview({ state: s = "waiting" }: { state?: State }) {
  state = s;
  if (s === "page")
    return (
      <OverFrame maxWidth={760} height={520}>
        <Unsettled ms={300} />
        <div className="@container/outbox flex h-full w-full flex-col">
          <RequestCard environmentId="local" id="r1" frame="page" />
        </div>
      </OverFrame>
    );
  return (
    <div className="w-full max-w-[720px] p-4">
      <Unsettled ms={300} />
      <RequestCard environmentId="local" id="r1" />
    </div>
  );
}
