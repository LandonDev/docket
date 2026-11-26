// @vitest-environment jsdom
import { registry as linkRegistry } from "../../lib/connection/registry";
import { IDLE_STATUS } from "../../lib/connection/types";
/**
 * The Outbox (docs/agents/work-outbox.md, "The screens") over two hosts
 * that answer from memory as `work.outbox.*` does: one list under each
 * workspace, the payload exactly as it goes, Edit, Send, Discard, a
 * group's Send N, a grant made from an item and removed, and Sent with who
 * pressed and when.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workTestClock } from "../testClock";
import type { GrantOffer, OutboxGrant, OutboxItem } from "@shared/contract-work-outbox";

type Call = { env: string; method: string; params: Record<string, unknown> };
const world = vi.hoisted(() => ({
  calls: [] as Call[],
  items: new Map<string, OutboxItem[]>(),
  grants: new Map<string, OutboxGrant[]>(),
  offers: new Map<string, GrantOffer[]>(),
  resultsDown: false,
  listDown: new Set<string>(),
  namedHosts: false,
  quote: null as string | null,
  getFails: false,
  /** the host's words for a full read it could not make (`work.outbox.get`), as its LifeOS session throws them */
  getCause: null as string | null,
  // a send the host has not answered yet: it answers when the test lets it
  grantId: 0,
  sendHeld: null as Promise<void> | null,
  // a press LifeOS takes: the host stores it sent and says what LifeOS said of each (by item id; "*" for all)
  sendSaid: {} as Record<string, "queued" | "confirmed" | "drafts" | "gone">,
  // what each decide was asked, by host
  decides: [] as { env: string; items: { ref: { id: string }; do: string; reason?: string; at?: number; rev?: number }[] }[],
  decideDown: false,
  // items a decide refuses, with the host's words
  refuse: {} as Record<string, string>,
  // what `get` adds to an item (changed.first, replied)
  extra: {} as Record<string, Partial<OutboxItem>>,
  // a thread's open requests, by host
  requests: new Map<string, unknown[]>(),
}));

vi.mock("../../lib/connection", async (original) => {
  const link = (env: string) => ({
    environmentId: env,
    connected: true,
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls.push({ env, method, params });
      const items = world.items.get(env) ?? [];
      const find = () => items.find((i) => i.ref.id === (params.ref as { id: string }).id)!;
      const now = Date.now();
      switch (method) {
        case "work.outbox.list": {
          if (world.listDown.has(env)) throw new Error("socket closed");
          const waiting = items.filter((i) => ["held", "live", "failed", "sending", "scheduled"].includes(i.state) || (i.state === "stale" && !i.dismissedAt));
          const done = items.filter((i) => i.state === "sent" || i.state === "discarded" || (i.state === "stale" && i.dismissedAt));
          return { items: params.show === "done" || params.show === "decided" ? done : waiting, waiting: waiting.filter((i) => i.state !== "scheduled" && i.state !== "sending").length };
        }
        case "work.outbox.decide": {
          if (params.request) {
            const r = (world.requests.get(env) ?? []).find((x) => (x as { id: string }).id === params.request) as Record<string, unknown>;
            return { request: { ...r, state: "answered", answeredBy: "owner", answeredAt: now } };
          }
          world.decides.push({ env, items: params.items as never });
          if (world.decideDown) throw new Error("No answer in 15 s");
          const results = (params.items as { ref: { id: string }; do: string; reason?: string; at?: number; zone?: string }[]).map((d) => {
            const it = items.find((i) => i.ref.id === d.ref.id)!;
            if (world.refuse[d.ref.id]) return { ref: it.ref, ok: false, error: world.refuse[d.ref.id] };
            if (d.do === "discard") Object.assign(it, { state: "discarded", decidedBy: "owner", decidedAt: now, ...(d.reason ? { reason: d.reason } : {}) });
            else if (d.do === "later") Object.assign(it, { state: "scheduled", scheduledFor: d.at, scheduledZone: d.zone });
            else Object.assign(it, { state: "sent", decidedBy: "owner", decidedAt: now, updatedAt: now, ...(world.sendSaid[it.ref.id] ? { lifeos: world.sendSaid[it.ref.id] } : {}) });
            return { ref: it.ref, ok: true, item: { ...it } };
          });
          return { results };
        }
        case "work.outbox.requests":
          return { requests: world.requests.get(env) ?? [] };
        case "work.outbox.request.get":
          return (world.requests.get(env) ?? []).find((r) => (r as { id: string }).id === params.id);
        case "work.outbox.askAgain":
          Object.assign(find(), { dismissedAt: now, reason: "out of date" });
          return find();
        case "work.outbox.cancelSend":
          Object.assign(find(), { state: "held", scheduledFor: undefined, scheduledZone: undefined });
          return find();
        case "work.outbox.sendNow":
          Object.assign(find(), { state: "sent", decidedBy: "owner", decidedAt: now, scheduledFor: undefined });
          return find();
        case "work.outbox.undoSend":
          Object.assign(find(), { state: "held", lifeos: undefined, decidedAt: null, decidedBy: null });
          return { back: true, item: find() };
        case "work.outbox.grants":
          return { grants: (world.grants.get(env) ?? []).filter((g) => !g.removedAt) };
        case "work.outbox.send":
          if (world.sendHeld) await world.sendHeld;
          // as the host: a row another press decided first is answered as it stands, and nothing runs
          if (!["held", "live", "failed"].includes(find().state)) return find();
          const said = world.sendSaid[find().ref.id] ?? world.sendSaid["*"];
          Object.assign(find(), { state: "sent", decidedBy: "owner", decidedAt: now, updatedAt: now, ...(said ? { lifeos: said } : {}) });
          return find();
        case "work.outbox.discard":
          Object.assign(find(), { state: "discarded", decidedBy: "owner", decidedAt: now, ...(params.reason ? { reason: params.reason } : {}) });
          return find();
        case "work.outbox.edit":
          Object.assign(find(), { payload: params.payload, updatedAt: now });
          return find();
        case "work.outbox.grant": {
          const grant = { id: `g${++world.grantId}`, workspaceId: "ws1", kind: "mail.send", matcher: params.matcher, label: String(params.label), madeFrom: params.from, routineId: null, createdAt: now, removedAt: null } as OutboxGrant;
          world.grants.set(env, [...(world.grants.get(env) ?? []), grant]);
          return grant;
        }
        case "work.outbox.offers":
          return { offers: world.offers.get(env) ?? [] };
        case "work.outbox.takeOffer": {
          const offer = (world.offers.get(env) ?? []).find((o) => o.id === params.id)!;
          world.offers.set(env, (world.offers.get(env) ?? []).filter((o) => o !== offer));
          const grant = { id: `g${++world.grantId}`, workspaceId: offer.workspaceId, kind: offer.kind, matcher: {}, label: offer.label, madeFrom: offer.from, routineId: null, createdAt: now, removedAt: null } as OutboxGrant;
          world.grants.set(env, [...(world.grants.get(env) ?? []), grant]);
          return grant;
        }
        case "work.outbox.dismissOffer": {
          const offer = (world.offers.get(env) ?? []).find((o) => o.id === params.id)!;
          world.offers.set(env, (world.offers.get(env) ?? []).filter((o) => o !== offer));
          return offer;
        }
        case "work.outbox.ungrant": {
          const grant = (world.grants.get(env) ?? []).find((g) => g.id === params.id)!;
          grant.removedAt = now;
          return grant;
        }
        case "work.outbox.results":
          if (world.resultsDown) throw new Error("The host did not answer");
          return { results: [] };
        case "work.outbox.get":
          if (world.getFails) throw new Error("The host did not answer");
          if (world.getCause) throw new Error(world.getCause);
          return { ...find(), ...(world.extra[find().ref.id] ?? {}), payload: { ...(find().payload as object), picture: { mimeType: "image/png", width: 16, height: 10, data: "AAAA" }, ...(world.quote ? { quote: world.quote } : {}) } };
      }
      throw new Error(`unknown ${method}`);
    },
  });
  const links = { box: link("box"), mac: link("mac") };
  const environments = [{ id: "box", name: "The box" }, { id: "mac", name: "Mac" }];
  const noEnvironments: typeof environments = [];
  return {
    ...(await original<typeof import("../../lib/connection")>()),
    useEnvironments: () => world.namedHosts ? environments : noEnvironments,
    registry: {
      linkOf: (env: "box" | "mac") => links[env],
      environment: (env: string) => ({ name: env === "box" ? "The box" : "Mac" }),
      onLink: (listener: (l: ReturnType<typeof link>, event: string) => void) => {
        listener(links.box, "added");
        listener(links.mac, "added");
        return () => undefined;
      },
    },
  };
});

vi.mock("../../chrome/WindowControls", () => ({ WindowControls: () => null }));
// A row's words are read once a draw: the count of draws a row had (M2: one read changing one item draws one row).
// A list row's button, counted by the row's key on each draw: what a read draws again (M2: one read changing one item
// draws one row). The list itself reads every row's words to find a section's repeated acts, so the words are no count.
const rowDraws = vi.hoisted(() => new Map<string, number>());
vi.mock("../../components/ui/item", async (original) => {
  const item = await original<typeof import("../../components/ui/item")>();
  const { createElement } = await import("react");
  return {
    ...item,
    ItemButton: (props: Record<string, unknown>) => {
      const key = props["data-outbox-row"];
      if (typeof key === "string") rowDraws.set(key, (rowDraws.get(key) ?? 0) + 1);
      return createElement(item.ItemButton as never, props as never);
    },
  };
});
vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));

import { GIVEN_KEY, resetTestKey, testKey } from "../../lib/linkMay.testkit";
import { toastAnchor } from "../../lib/toastAnchor";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { batchVerb, canEdit, OutboxView, rememberOutboxTab, rowWords } from "./OutboxView";
import { loadHost, loadOutbox, resetOutboxStore, wantOutboxItem } from "./store";

const mail = (id: string, to: string, subject: string, extra: Partial<OutboxItem> = {}): OutboxItem => ({
  ref: { at: "lifeos", table: "outbox", id },
  kind: "mail.send",
  workspaceId: "ws1",
  sessionId: "t1",
  sector: "purdue",
  summary: `Send to ${to}: ${subject}`,
  verb: "Send",
  account: "landon@purdue.edu",
  state: "held",
  payload: { id, status: "draft", message: { kind: "mail", accountId: "acc", to: [{ name: to, address: `${to.split(" ")[0]!.toLowerCase()}@purdue.edu` }], cc: [], bcc: [], subject, html: `<p>Hello ${to},</p><p>About ${subject}.</p><p>Landon</p>`, text: `Hello ${to},\n\nAbout ${subject}.\n\nLandon` } },
  createdAt: 1_000 + Number(id.replace(/\D/g, "")),
  decidedBy: null,
  decidedAt: null,
  n: null,
  why: "lifeos",
  grantId: null,
  error: null,
  result: null,
  routineRunId: null,
  updatedAt: 500,
  ...extra,
});
const addonCall: OutboxItem = {
  ...mail("h9", "x", "y"),
  ref: { at: "host", id: "h9" },
  kind: "addon.call",
  workspaceId: "ws2",
  sector: "unify",
  summary: "Post message with Slack: “Spring LAN is set”",
  verb: "Send",
  why: "rule",
  n: 1,
  payload: { addonId: "a1", addon: "Slack", tool: "post_message", words: "Post message", arguments: { channel: "staff", text: "Spring LAN is set" }, specDigest: "d" },
};

const now = workTestClock();

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  world.calls = [];
  world.grantId = 0;
  world.items = new Map([
    ["box", [mail("o1", "Dana Lee", "Budget"), mail("o2", "Sam Ortiz", "Scrims"), mail("o3", "Events booking", "Ballroom")]],
    // a copy: a press marks the host's row sent, and the next test must find it held again
    ["mac", [{ ...addonCall }]],
  ]);
  world.grants = new Map();
  world.offers = new Map();
  world.resultsDown = false;
  world.listDown.clear();
  world.namedHosts = false;
  world.sendHeld = null;
  world.sendSaid = {};
  world.decides = [];
  world.decideDown = false;
  world.refuse = {};
  world.extra = {};
  world.requests = new Map();
  workSwitch.reset();
  setWorkOn("box", true);
  setWorkOn("mac", true);
  resetOutboxStore();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetTestKey();
});

async function open(onOpenSession?: (sessionId: string, environmentId: string) => void) {
  render(<OutboxView besideRail onClose={() => undefined} onOpenSession={onOpenSession} />);
  // the page keeps the tab it was left on; each test starts on Waiting
  fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
  await waitFor(() => expect(screen.getAllByText("Send to Dana Lee").length).toBeGreaterThan(0), { timeout: 5000 });
  // The detail's act view is a chunk of its own: Send waits for its payload on screen.
  await waitFor(() => expect(document.querySelector('[data-outbox-detail] [data-slot="act-payload"]')).not.toBeNull(), { timeout: 5000 });
}
const sends = () => world.calls.filter((c) => c.method === "work.outbox.send");

it("holds the selected draft and its shortcut while the link is down, then frees Send", async () => {
  let status = { ...IDLE_STATUS, transport: "open" as "open" | "reconnecting" | "offline" };
  const statuses = vi.spyOn(linkRegistry, "statusOf").mockImplementation((id) => id === "box" ? status : IDLE_STATUS);
  const environment = vi.spyOn(linkRegistry, "environment").mockReturnValue({ name: "The box" } as never);
  try {
    const view = render(<OutboxView besideRail onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    const send = () => screen.getByRole<HTMLButtonElement>("button", { name: "Send", exact: true });
    const discard = () => screen.getByRole<HTMLButtonElement>("button", { name: "Discard", exact: true });
    await waitFor(() => expect(send().disabled).toBe(false), { timeout: 5000 });
    expect(discard().disabled).toBe(false);
    for (const transport of ["reconnecting", "offline"] as const) {
      status = { ...status, transport };
      view.rerender(<OutboxView besideRail onClose={() => {}} />);
      expect(send().disabled).toBe(true);
      // Discard goes to the host too: held in place, and its key opens nothing (council R1-A19).
      expect(discard().disabled).toBe(true);
      fireEvent.keyDown(document.querySelector("[data-work-outbox]")!, { key: "d" });
      expect(screen.queryByRole("textbox", { name: "Why, for the thread" })).toBeNull();
      // The link's one wording (`linkWords`), as the line over the composer says it.
      expect(screen.getAllByText(transport === "offline" ? "The box is offline" : "Reconnecting to the box…")).toHaveLength(1);
      fireEvent.click(send());
      fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true });
      expect(sends()).toHaveLength(0);
    }
    world.listDown.add("box");
    const { loadHost } = await import("./store");
    await act(async () => loadHost("box"));
    expect(screen.getAllByText("The box is offline")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(send().disabled).toBe(true);
    world.listDown.clear();
    status = { ...status, transport: "open" };
    view.rerender(<OutboxView besideRail onClose={() => {}} />);
    expect(send().disabled).toBe(false);
    expect(discard().disabled).toBe(false);
    expect(screen.queryByText("The box is offline")).toBeNull();
  } finally {
    cleanup();
    statuses.mockRestore();
    environment.mockRestore();
  }
});

describe("the list's draws", () => {
  it("a read that changed one item draws that row alone", async () => {
    await open();
    const draws = (id: string) => [...rowDraws].filter(([key]) => key.endsWith(`:${id}`)).reduce((n, [, count]) => n + count, 0);
    const [o2, o3] = [draws("o2"), draws("o3")];
    expect(o2).toBeGreaterThan(0);
    Object.assign(world.items.get("box")![1]!, { summary: "Send to Sam Ortiz: Scrims moved", updatedAt: Date.now() + 1 });
    await act(async () => void (await loadHost("box")));
    await waitFor(() => expect(draws("o2")).toBeGreaterThan(o2));
    expect([draws("o2") - o2, draws("o3") - o3]).toEqual([1, 0]);
  });});

describe("a mail or calendar act LifeOS holds after his press", () => {
  const MIN = 60_000;
  const row = (title: string) => screen.getAllByText(title).find((el) => el.closest("li"))!.closest("li")!.textContent;

  it("reads Queued in LifeOS with its age in Sent until LifeOS says it went, then Sent; back in drafts or gone says so; none takes a press", async () => {
    world.items.set("box", [
      // pressed twelve minutes ago (and a little), LifeOS still holds it: its age is from the press
      mail("o1", "Dana Lee", "Budget", { state: "sent", decidedBy: "owner", decidedAt: Date.now() - 12 * MIN - 5_000, lifeos: "queued", n: 1 }),
      mail("o2", "Sam Ortiz", "Scrims", { state: "sent", decidedBy: "owner", decidedAt: Date.now() - 13 * MIN, lifeos: "confirmed", n: 2 }),
      mail("o3", "Events booking", "Ballroom", { state: "sent", decidedBy: "owner", decidedAt: Date.now() - 14 * MIN, lifeos: "drafts", n: 3 }),
      mail("o4", "Ana Ruiz", "Roster", { state: "sent", decidedBy: "owner", decidedAt: Date.now() - 15 * MIN, lifeos: "gone", n: 4 }),
      mail("o5", "Kim Park", "Kits", { state: "sent", decidedBy: "owner", decidedAt: Date.now() - 16 * MIN, n: 5 }),
    ]);
    rememberOutboxTab("sent");
    render(<OutboxView besideRail onClose={() => undefined} />);
    await waitFor(() => expect(screen.getAllByText("Sent to Sam Ortiz").length).toBeGreaterThan(0), { timeout: 5000 });
    // in Sent, where a sent row sits, but never called sent before LifeOS says so
    expect(row("Send to Dana Lee")).toContain("Queued in LifeOS for 12m");
    expect(screen.queryByText("Sent to Dana Lee")).toBeNull();
    expect(row("Sent to Sam Ortiz")).toContain("Scrims");
    expect(row("Send to Events booking")).toContain("Back in drafts in LifeOS");
    expect(row("Send to Ana Ruiz")).toContain("No longer in LifeOS");
    expect(row("Sent to Kim Park")).toContain("Kits");
    // the detail says it as the row does: who and when, the state and its age, and no line about taking it back
    fireEvent.click(screen.getAllByText("Send to Dana Lee").find((el) => el.closest("li"))!);
    await waitFor(() => expect(document.querySelector("[data-outbox-detail] p[role=status]")?.textContent).toBe("Queued in LifeOSfor 12m"));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Send to Dana Lee");
    expect(document.querySelector("[data-outbox-detail]")?.textContent).toContain("by you");
    expect(document.querySelector("[data-outbox-detail]")?.textContent).not.toContain("Sent by you");
    expect(screen.queryByText("Sent mail cannot be taken back")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    // and no empty bar under it: nothing waits there to be pressed
    expect(document.querySelector("[data-outbox-detail] [data-outbox-verbs]")).toBeNull();
    fireEvent.click(screen.getByText("Sent to Sam Ortiz"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sent to Sam Ortiz"));
    expect(document.querySelector("[data-outbox-detail] p[role=status]")).toBeNull();
    expect(screen.getByText("Sent mail cannot be taken back")).toBeTruthy();
    expect(document.querySelector("[data-outbox-detail] [data-outbox-verbs]")).not.toBeNull();
    expect(sends()).toEqual([]);
  });

  it("a press LifeOS took says Queued in LifeOS in its toast, never Sent", async () => {
    world.sendSaid = { "*": "queued" };
    const { Toaster } = await import("../../components/ui/toaster");
    render(<Toaster />);
    await open();
    // Send waits until the mail is on screen whole
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    await waitFor(() => expect(document.body.textContent).toContain("Queued in LifeOS: Budget"), { timeout: 5000 });
    expect(document.body.textContent).not.toContain("Sent: Budget");
  });

  it("Select 3 then Send 3: each row says what LifeOS said of it, as its row in Done would, and the head sums the press", async () => {
    world.sendSaid = { o1: "queued", o2: "drafts", o3: "confirmed" };
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Select 3" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send 3" })));
    // Queued is counted as queued, never as sent; a plain send's check says it alone.
    await waitFor(() => expect(document.querySelector("[data-outbox-summary] h1")!.textContent).toBe("Sent 2, queued 1 in LifeOS"), { timeout: 5000 });
    const rows = [...document.querySelectorAll("[data-summary-row]")];
    expect(rows[0]!.textContent).toContain("Queued in LifeOS");
    expect(rows[1]!.textContent).toContain("Back in drafts in LifeOS");
    expect(rows[2]!.querySelector('[aria-label="Done"]')).toBeTruthy();
    expect(rows[2]!.querySelector("[data-summary-side]")).toBeNull();
  });
});

describe("the Outbox", () => {
  it("lists every host's held acts under their workspace, and shows exactly what goes", async () => {
    await open();
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Outbox", "A Work workspace", "A Work workspace"]);
    // the first is open: mail's own view (milestone 23), its fields and its body as plain text
    // the mail act's own view loads as its own chunk: cold, under a full run's load, it takes longer than waitFor's second
    await waitFor(() => expect([...document.querySelectorAll("dd")].map((d) => d.textContent)).toContain("Dana Lee dana@purdue.edu"), { timeout: 5000 });
    expect(screen.getByText(/About Budget\./)).toBeTruthy();
    fireEvent.click(screen.getByText("Post message with Slack"));
    expect(screen.getByText("staff")).toBeTruthy();
  });

  it("seats the toast stack above an open item's verbs, so a notice that stays never covers Send", async () => {
    await open();
    await waitFor(() => expect(toastAnchor()?.hasAttribute("data-outbox-verbs")).toBe(true), { timeout: 5000 });
    expect(within(toastAnchor()!).getByRole("button", { name: "Send" })).toBeTruthy();
    cleanup();
    expect(toastAnchor()).toBeNull();
  });

  it("opens on the item a notice asked for, not the first: even when the lists it mounts with are from before that item was made", async () => {
    // As at launch: the store read each host while nothing was held, so it says loaded with empty lists.
    const later = world.items;
    world.items = new Map();
    await loadOutbox();
    world.items = later;
    wantOutboxItem("box:lifeos:o3");
    render(<OutboxView besideRail onClose={() => undefined} />);
    await waitFor(() => expect(document.querySelector("[aria-current=true]")?.textContent).toContain("Send to Events booking"), { timeout: 5000 });
    // taken once: a later reload leaves his own pick alone
    fireEvent.click(screen.getAllByText("Send to Dana Lee")[0]!);
    await act(async () => void (await loadOutbox()));
    expect(document.querySelector("[aria-current=true]")?.textContent).toContain("Send to Dana Lee");
  });

  it("opens on the item asked for (Open in Outbox from the composer) in its own tab, though Sent was the tab left open and another item is first", async () => {
    await loadOutbox();
    rememberOutboxTab("sent");
    wantOutboxItem("box:lifeos:o3");
    render(<OutboxView besideRail onClose={() => undefined} />);
    await waitFor(() => expect(document.querySelector("[aria-current=true]")?.textContent).toContain("Send to Events booking"), { timeout: 5000 });
    expect(screen.getByRole("tab", { name: "Waiting" }).getAttribute("aria-selected")).toBe("true");
  });

  it("brings the row of an item asked for into the list's view, at its nearest edge, with no motion", async () => {
    await loadOutbox();
    const seen: { row: string | null; how: unknown }[] = [];
    const had = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Element.prototype.scrollIntoView = function (this: Element, how?: unknown) {
      seen.push({ row: this.getAttribute("data-outbox-row"), how });
    };
    try {
      wantOutboxItem("box:lifeos:o3");
      render(<OutboxView besideRail onClose={() => undefined} />);
      await waitFor(() => expect(seen.map((s) => s.row)).toContain("box:lifeos:o3"), { timeout: 5000 });
      expect(seen.find((s) => s.row === "box:lifeos:o3")!.how).toEqual({ block: "nearest" });
      // Once: his own pick after it does not scroll the list under him.
      const before = seen.length;
      fireEvent.click(screen.getAllByText("Send to Dana Lee")[0]!);
      await act(async () => void (await loadOutbox()));
      expect(seen.slice(before).filter((s) => s.row === "box:lifeos:o3")).toEqual([]);
    } finally {
      if (had) Object.defineProperty(Element.prototype, "scrollIntoView", had);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("an item asked for that is gone leaves the page as it opens, and is forgotten when the page closes", async () => {
    wantOutboxItem("box:lifeos:nothing");
    const view = render(<OutboxView besideRail onClose={() => undefined} />);
    await waitFor(() => expect(document.querySelector("[aria-current=true]")?.textContent).toContain("Send to Dana Lee"), { timeout: 5000 });
    view.unmount();
    world.items.get("box")!.push(mail("nothing", "Late Arrival", "Later"));
    // Reopened more than 30 s later (a reopen sooner is answered from what the store holds, kept current by the pushes).
    vi.setSystemTime(Date.now() + 31_000);
    render(<OutboxView besideRail onClose={() => undefined} />);
    await waitFor(() => expect(screen.getAllByText("Send to Late Arrival").length).toBeGreaterThan(0), { timeout: 5000 });
    expect(document.querySelector("[aria-current=true]")?.textContent).toContain("Send to Dana Lee");
  });

  it("sends a LifeOS draft with the updatedAt it was shown with, through the host that holds it", async () => {
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(sends()).toEqual([{ env: "box", method: "work.outbox.send", params: { ref: { at: "lifeos", table: "outbox", id: "o1" }, rev: 500, via: "outbox" } }]);
    await waitFor(() => expect(screen.queryAllByText("Send to Dana Lee")).toEqual([]));
  });

  it("reads a LifeOS mail whole before it may go, so the quote LifeOS sends under a reply is shown", async () => {
    world.quote = "<p>On Tue, Dana wrote:</p><p>Can you send the budget?</p>";
    try {
      await open();
      await waitFor(() => expect(document.querySelector("[data-mail-quote]")?.textContent).toBe("On Tue, Dana wrote:\n\nCan you send the budget?"), { timeout: 5000 });
      expect(world.calls.some((c) => c.method === "work.outbox.get")).toBe(true);
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      world.quote = null;
    }
  });

  it("says why a LifeOS mail could not be read whole, by the rule with its host named, and reads it again when that host is back", async () => {
    // Council round 9 (Sol Outbox 1, P2): the read's own cause, never a bare "did not load".
    const { resetLifeos, setLifeosStatus } = await import("../shell/lifeos");
    world.quote = "<p>On Tue, Dana wrote:</p>";
    world.getCause = "This host is not signed in to LifeOS";
    try {
      await open();
      const line = await waitFor(() => document.querySelector("[data-mail-unread]")!);
      expect(line.getAttribute("data-mail-unread")).toBe("signed-out");
      expect(line.textContent).toContain("Not signed in to LifeOS on the box");
      expect(line.textContent).not.toContain("did not load");
      // A state, not silence: a muted note, not an alert.
      expect(line.closest("[data-outbox-note]")?.getAttribute("role")).toBeNull();
      expect(line.querySelector("button")?.textContent).not.toBe("Retry");
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
      // Council round 10 (Sol Outbox 1): a sign-in begun elsewhere changes the note at once, from the live status.
      act(() => setLifeosStatus("box", { lifeos: { state: "pairing", expiresAt: Date.now() + 600_000 }, keys: [] } as never));
      await waitFor(() => expect(document.querySelector("[data-mail-unread]")?.getAttribute("data-mail-unread")).toBe("pairing"));
      expect(document.querySelector("[data-mail-unread]")!.textContent).toContain("The LifeOS sign-in on the box waits for your approval");
      // The box signs in: its status says connected, and the mail is read again with no press.
      world.getCause = null;
      act(() => setLifeosStatus("box", { lifeos: { state: "connected" }, keys: [] } as never));
      await waitFor(() => expect(document.querySelector("[data-mail-quote]")).toBeTruthy(), { timeout: 5000 });
      expect(document.querySelector("[data-mail-unread]")).toBeNull();
      cleanup();
      // Silence is red with Retry, which reads the mail again.
      world.getCause = "LifeOS is unreachable";
      await open();
      const silent = await waitFor(() => document.querySelector("[data-mail-unread]")!);
      expect(silent.textContent).toContain("LifeOS did not answer the box");
      // Silence is the red note: the failed mark, read out as an alert.
      expect(silent.closest("[data-outbox-note]")?.getAttribute("role")).toBe("alert");
      const gets = world.calls.filter((c) => c.method === "work.outbox.get").length;
      world.getCause = null;
      fireEvent.click(within(silent as HTMLElement).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(world.calls.filter((c) => c.method === "work.outbox.get").length).toBe(gets + 1));
      await waitFor(() => expect(document.querySelector("[data-mail-quote]")).toBeTruthy(), { timeout: 5000 });
      resetLifeos();
    } finally {
      world.quote = null;
      world.getCause = null;
    }
  });

  it("edits what goes where it stands: the fields turn into inputs, Save keeps it held, Cancel puts it back", async () => {
    await open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // No dialog: the thing being edited is the thing on screen.
    expect(screen.queryByRole("dialog")).toBeNull();
    const detail = document.querySelector("[data-outbox-detail]") as HTMLElement;
    fireEvent.change(within(detail).getByLabelText("Subject"), { target: { value: "Budget, second draft" } });
    expect(within(detail).getByRole("button", { name: "Cancel" })).toBeTruthy();
    await act(async () => fireEvent.click(within(detail).getByRole("button", { name: "Save" })));
    const edit = world.calls.find((c) => c.method === "work.outbox.edit")!;
    expect((edit.params.payload as { message: { subject: string } }).message.subject).toBe("Budget, second draft");
    await waitFor(() => expect(document.querySelector("[data-outbox-editing]")).toBeNull());
    expect(sends()).toEqual([]);
  });

  it("saves an edit with the command key and S, and Escape leaves the edit before it leaves the page", async () => {
    const closed = vi.fn();
    render(<OutboxView besideRail onClose={closed} />);
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.keyDown(document.querySelector("[data-outbox-detail] h1")!, { key: "Escape" });
    expect(document.querySelector("[data-outbox-editing]")).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const subject = within(document.querySelector("[data-outbox-detail]") as HTMLElement).getByLabelText("Subject");
    fireEvent.change(subject, { target: { value: "Budget v3" } });
    await act(async () => fireEvent.keyDown(subject, { key: "s", metaKey: true, ctrlKey: false }));
    await act(async () => fireEvent.keyDown(subject, { key: "s", ctrlKey: true, metaKey: false }));
    expect(world.calls.filter((c) => c.method === "work.outbox.edit").length).toBeGreaterThan(0);
  });

  it("Discard asks why, for the thread, in a popover over its button, and the host hears his words", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    const field = await screen.findByRole("textbox", { name: "Why, for the thread" });
    fireEvent.change(field, { target: { value: "She paid yesterday. Thank her instead." } });
    const pop = field.closest("[data-slot=popover-content]") as HTMLElement;
    await act(async () => fireEvent.click(within(pop).getByRole("button", { name: "Discard" })));
    expect(world.calls.filter((c) => c.method === "work.outbox.discard").map((c) => c.params)).toEqual([
      { ref: { at: "lifeos", table: "outbox", id: "o1" }, rev: 500, reason: "She paid yesterday. Thank her instead.", via: "outbox" },
    ]);
  });

  it("Select 3 on a thread's heading ticks its items, and Send 3 is one decide on their host, nothing of another job", async () => {
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Select 3" })));
    expect(document.querySelector("[data-outbox-summary] h1")!.textContent).toBe("Send 3 mails to 3 people");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send 3" })));
    expect(world.decides).toEqual([
      {
        env: "box",
        items: [
          { ref: { at: "lifeos", table: "outbox", id: "o1" }, do: "send", rev: 500 },
          { ref: { at: "lifeos", table: "outbox", id: "o2" }, do: "send", rev: 500 },
          { ref: { at: "lifeos", table: "outbox", id: "o3" }, do: "send", rev: 500 },
        ],
      },
    ]);
    expect(sends()).toEqual([]);
  });

  it("a reply that quotes its mail says Open to send and stays out of Send N: only Discard takes it in a group", async () => {
    world.quote = "<p>On Tue, Dana wrote:</p>";
    try {
      await open();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Select 3" })));
      await waitFor(() => expect([...document.querySelectorAll("[data-summary-row]")].every((r) => r.textContent!.includes("Open to send"))).toBe(true), { timeout: 5000 });
      expect(screen.queryByRole("button", { name: /^Send \d/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Discard 3" })).toBeTruthy();
      expect(document.querySelector("[data-outbox-summary] h1")!.textContent).toBe("Discard 3 mails");
    } finally {
      world.quote = null;
    }
  });

  it("a host that refuses one item of a press says why on that row alone, and Send again takes only it", async () => {
    world.refuse = { o2: "This went out of date: discard it, or ask the thread again." };
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Select 3" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send 3" })));
    await waitFor(() => expect(document.querySelector("[data-outbox-summary] h1")!.textContent).toBe("Sent 2, 1 not sent"), { timeout: 5000 });
    const rows = [...document.querySelectorAll("[data-summary-row]")];
    expect(rows[1]!.querySelector("[data-summary-side]")!.textContent).toBe("This went out of date: discard it, or ask the thread again.");
    expect(rows[0]!.textContent).not.toContain("out of date");
    expect(screen.getByRole("button", { name: "Send 1 again" })).toBeTruthy();
  });

  it("a host that does not answer a press fails each of its rows with why, and leaves another host's rows as they went", async () => {
    world.decideDown = true;
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick Send to Sam Ortiz" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick Post message with Slack" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send 2" })));
    await waitFor(() => expect(document.querySelector("[data-outbox-summary] h1")!.textContent).toBe("2 not sent"), { timeout: 5000 });
  });

  it("leaves a computer act out of its group's count and gives it no tick: it is sent from its own detail", async () => {
    const click: OutboxItem = { ...addonCall, state: "held", ref: { at: "host", id: "c4" }, workspaceId: "ws1", kind: "computer.act", summary: "Click Send in Mail", payload: { title: "Click Send in Mail", app: "Mail" } };
    world.items.set("box", [mail("o1", "Dana Lee", "Budget"), mail("o2", "Sam Ortiz", "Scrims"), { ...click }]);
    await open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Select 2" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Select 3" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Tick Click Send in Mail" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Tick Send to Sam Ortiz" })).toBeTruthy();
  });

  it("a send that may have gone offers no plain Send: a line to check Sent, his own Send again, and no group or tick takes it", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { state: "failed", error: "Outlook did not answer in time", outcomeUnknown: true }), mail("o2", "Sam Ortiz", "Scrims"), mail("o3", "Events booking", "Ballroom")]);
    await open();
    await waitFor(() => expect(screen.getByText("Check Sent first")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "More ways to send" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Tick Send to Dana Lee" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send again" })));
    expect(sends().at(-1)!.params).toEqual({ ref: { at: "lifeos", table: "outbox", id: "o1" }, rev: 500, again: true, via: "outbox" });
  });

  it("ticked rows of two hosts go as one decide to each", async () => {
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick Send to Sam Ortiz" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick Post message with Slack" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send 2" })));
    expect(world.decides.map((d) => [d.env, d.items.map((i) => i.ref.id)]).sort()).toEqual([
      ["box", ["o2"]],
      ["mac", ["h9"]],
    ]);
    // A press that spans hosts is many on each host: a one-item part earns no grant offer.
    expect(world.calls.filter((c) => c.method === "work.outbox.decide").every((c) => c.params.many === true)).toBe(true);
  });

  it("makes a grant only from an item's Send menu, lists it, and removes it", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "More ways to send" }));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Mail to Dana Lee" })));
    expect(world.calls.find((c) => c.method === "work.outbox.grant")!.params).toEqual({ from: { at: "lifeos", table: "outbox", id: "o1" }, matcher: { accountId: "acc", recipients: ["dana@purdue.edu"] }, label: "Mail to Dana Lee" });
    expect(sends()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Grants" }));
    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(within(sheet).getByText("Mail to Dana Lee")).toBeTruthy());
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Remove" })));
    expect(world.calls.filter((c) => c.method === "work.outbox.ungrant")).toHaveLength(1);
    await waitFor(() => expect(within(sheet).getByText("No grants. Everything waits for your press.")).toBeTruthy());
  });

  it("a given computer's key sends, and is offered no grant: no Send menu, no Remove", async () => {
    testKey.current = GIVEN_KEY;
    world.grants.set("box", [{ id: "g1", workspaceId: "ws1", kind: "mail.send", matcher: {}, label: "Mail to Dana Lee", madeFrom: null, routineId: null, createdAt: 1, removedAt: null } as unknown as OutboxGrant]);
    await open();
    expect(screen.queryByRole("button", { name: "More ways to send" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(sends()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Grants" }));
    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(within(sheet).getByText("Mail to Dana Lee")).toBeTruthy());
    expect(within(sheet).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(world.calls.some((c) => /^work\.outbox\.(grant|ungrant|takeOffer|dismissOffer)$/.test(c.method))).toBe(false);
  });

  it("puts what left under Done, with who pressed and when", async () => {
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    fireEvent.click(screen.getByRole("tab", { name: "Done" }));
    await waitFor(() => expect(screen.getAllByText("Sent to Dana Lee").length).toBeGreaterThan(0));
    // The title says it went: the head says where, when and by whom, with no second "Sent".
    const facts = document.querySelector("[data-outbox-detail] header [data-slot=facts]")!.textContent!;
    expect(facts).toMatch(/^A Work workspace.+by you$/);
    expect(facts).not.toContain("Sent");
    expect(screen.getByText("Sent mail cannot be taken back")).toBeTruthy();
  });

  it("groups Done by day, newest first, each row led by its kind's glyph and ending in its time", async () => {
    const DAY = 86_400_000;
    world.items.set("box", [
      mail("o1", "Dana Lee", "Budget", { state: "sent", decidedBy: "owner", decidedAt: Date.now() - 60_000 }),
      mail("o2", "Sam Ortiz", "Scrims", { state: "discarded", decidedBy: "owner", decidedAt: Date.now() - DAY, reason: "Already booked" }),
    ]);
    world.items.set("mac", [{ ...addonCall, state: "sent", decidedBy: "owner", decidedAt: Date.now() - 90_000 }]);
    rememberOutboxTab("done");
    render(<OutboxView besideRail onClose={() => undefined} />);
    await waitFor(() => expect(screen.getAllByText("Sent to Dana Lee").length).toBeGreaterThan(0), { timeout: 5000 });
    const groups = [...document.querySelectorAll("[data-outbox-list] section")];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Today", "Yesterday"]);
    expect(groups[0]!.querySelectorAll("li")).toHaveLength(2);
    expect(groups[1]!.textContent).toContain("Discarded");
    for (const group of groups) expect(group.querySelector("li svg")).toBeTruthy();
    // What he discarded keeps the words he gave the thread.
    fireEvent.click(screen.getByText("Send to Sam Ortiz"));
    await waitFor(() => expect(document.querySelector("[data-outbox-detail]")!.textContent).toContain('Discarded. You told the thread: “Already booked”'));
  });

  it("says a failed send's reason once, in the detail and in his words: the row keeps what it is about", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { state: "failed", error: "forbidden: work.outbox.send needs admin" })]);
    await open();
    const row = screen.getAllByText("Send to Dana Lee").find((el) => el.closest("li"))!.closest("li")!;
    expect(row.textContent).toContain("Budget");
    expect(row.textContent).not.toContain("forbidden");
    const alert = within(document.querySelector("[data-outbox-detail]") as HTMLElement).getByRole("alert");
    expect(alert.textContent).toBe("Not sent. This computer's key may not do that on that computer. Do it from a computer that manages that computer.");
    // It leads Waiting, under Not sent.
    expect(document.querySelector("[data-outbox-section]")!.getAttribute("data-outbox-section")).toBe("failed");
  });

  it("draws each row on one line: the act, what it is about, and one trailing word", async () => {
    await open();
    const row = screen.getAllByText("Send to Dana Lee").find((el) => el.closest("li"))!.closest("li")!;
    const button = row.querySelector("button")!;
    expect(button.className).toContain("h-8");
    // The act and what it is about share one line that wraps into a hidden second; the trailing word stands apart.
    const [words, side] = [...button.children];
    expect([...words!.children].map((c) => c.textContent)).toEqual(["Send to Dana Lee", "Budget"]);
    expect(words!.className).toContain("flex-wrap");
    expect(words!.className).toContain("overflow-hidden");
    expect(words!.lastElementChild!.className).toContain("min-w-16");
    expect(side!.textContent).toMatch(/\d:\d\d [AP]M|\w{3} \d/);
  });

  it("when the item he reads is decided elsewhere, the detail empties rather than slide the next one under Send", async () => {
    await open();
    world.items.get("box")![0]!.state = "discarded";
    const { loadOutbox } = await import("./store");
    await act(async () => loadOutbox());
    await waitFor(() => expect(screen.getByText("No longer waiting")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("a press the host answers with another decision is not called sent", async () => {
    await open();
    world.items.get("box")![0]!.state = "discarded";
    const { loadToast } = await import("../../components/ui/toaster");
    const toast = await loadToast();
    const error = vi.spyOn(toast, "error");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(error).toHaveBeenCalledWith("Already discarded");
  });

  it("never draws Held in amber: no waiting mark anywhere on the page", async () => {
    await open();
    expect(document.querySelector('[data-state="waiting"]')).toBeNull();
  });

  it("says the detail's facts as one comma sentence, never with a middle dot", async () => {
    await open();
    const facts = document.querySelector("header [data-slot=facts]") as HTMLElement;
    expect(facts).toBeTruthy();
    expect(facts.closest("header")!.textContent).not.toContain("·");
  });

  it("names a held item's job in its head at every width, as a sent one's does: never the dot alone", async () => {
    await open();
    const facts = [...document.querySelectorAll("header [data-slot=facts]")] as HTMLElement[];
    expect(facts).toHaveLength(1);
    expect(facts[0]!.className).not.toContain("hidden");
    expect(facts[0]!.textContent).toMatch(/^A Work workspace/);
  });

  it("says a rewrite waits once, in the mail's own view, not again over it", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { proposed: true } as Partial<OutboxItem>)]);
    await open();
    expect(screen.queryByText("An agent's rewrite waits in this draft; what shows is what goes.")).toBeNull();
  });

  it("says a mixed batch went as Sent N, never in its first item's verb", () => {
    expect(batchVerb([{ verb: "Post" }, { verb: "Send" }])).toBe("Sent");
    expect(batchVerb([{ verb: "Post" }, { verb: "Post" }])).toBe("Posted");
    expect(batchVerb([{ verb: "Send" }])).toBe("Sent");
    // a verb of several words counts on its first: "Made 3", never "Made the change 3"
    expect(batchVerb([{ verb: "Make the change", kind: "office.edit" }, { verb: "Make the change", kind: "office.edit" }])).toBe("Made");
    expect(batchVerb([{ verb: "Make the change", kind: "office.edit" }, { verb: "Make 2 changes", kind: "google.edit" }])).toBe("Made");
  });

  it("offers Edit only where something can change", async () => {
    expect(canEdit(mail("o1", "Dana Lee", "Budget"))).toBe(true);
    expect(canEdit({ state: "live", payload: { title: "Click Send", app: "Mail" } })).toBe(false);
    expect(canEdit({ state: "held", payload: { id: "x", html: "<p>Only html</p>" } })).toBe(false);
    // An Outlook reply: everything shown is the host's to keep, so Edit has nothing to offer.
    const outlookReply = { host: "env_mac", account: "landon@purdue.edu", to: ["events@purdue.edu"], subject: "Re: Ballroom", replyTo: "AAMk", html: "<p>Yes</p>" };
    expect(canEdit({ kind: "office.mail.send", state: "held", payload: outlookReply } as never)).toBe(false);
    expect(canEdit({ kind: "office.mail.send", state: "held", payload: { ...outlookReply, replyTo: undefined } } as never)).toBe(true);
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { state: "live" })]);
    await open();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("names the host whose screen a computer act takes, and keeps its picture in Done", async () => {
    const click: OutboxItem = { ...addonCall, state: "held", ref: { at: "host", id: "c1" }, kind: "computer.act", summary: "Click Send in Mail", payload: { title: "Click Send in Mail", app: "Mail", picture: { mimeType: "image/png", width: 16, height: 10 } } };
    // The last test's press reloads its host as it ends: let that land before this world is read.
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    world.items.set("mac", [click]);
    world.items.set("box", []);
    resetOutboxStore();
    render(<OutboxView besideRail onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await waitFor(() => expect(screen.getAllByText("Click Send in Mail").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText(/screen for a moment\./)).toBeTruthy());
    expect(screen.queryByText(/this host's screen/)).toBeNull();
    // Held, the picture he approves sits above the verbs.
    const held = (await screen.findByRole("img")) as HTMLImageElement;
    expect(held.src).toBe("data:image/png;base64,AAAA");
    // Send waits until the picture has drawn
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.load(held);
    expect(held.compareDocumentPosition(screen.getByRole("button", { name: "Send" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    fireEvent.click(screen.getByRole("tab", { name: "Done" }));
    const picture = (await screen.findByRole("img")) as HTMLImageElement;
    expect(picture.src).toBe("data:image/png;base64,AAAA");
    expect(world.calls.some((c) => c.method === "work.outbox.get")).toBe(true);
  });

  it("offers no Send for a computer act until its kept picture is on screen", async () => {
    const click: OutboxItem = { ...addonCall, state: "held", ref: { at: "host", id: "c2" }, kind: "computer.act", summary: "Click Send in Mail", payload: { title: "Click Send in Mail", app: "Mail", picture: { mimeType: "image/png", width: 16, height: 10 } } };
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    world.items.set("mac", [click]);
    world.items.set("box", []);
    world.getFails = true;
    try {
      resetOutboxStore();
      render(<OutboxView besideRail onClose={() => undefined} />);
      fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
      await waitFor(() => expect(screen.getByText("The picture did not load")).toBeTruthy());
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
      world.getFails = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      fireEvent.load(await screen.findByRole("img"));
      await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    } finally {
      world.getFails = false;
    }
  });

  it("keeps a failed read of the Results apart from an act with no way back, with Retry", async () => {
    world.resultsDown = true;
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    fireEvent.click(screen.getByRole("tab", { name: "Done" }));
    await waitFor(() => expect(screen.getByText("The host did not answer")).toBeTruthy());
    expect(screen.queryByText("Sent mail cannot be taken back")).toBeNull();
    world.resultsDown = false;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(screen.getByText("Sent mail cannot be taken back")).toBeTruthy());
  });

  it("narrow, a tick stays in the list; Review N opens the ticked rows and Waiting goes back with the ticks kept", async () => {
    await open();
    const list = document.querySelector("[data-outbox-list]") as HTMLElement;
    const detail = () => document.querySelector("[data-outbox-detail]") as HTMLElement;
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick Send to Sam Ortiz" }));
    expect(list.className).not.toContain("@max-[40rem]/outbox:hidden");
    fireEvent.click(screen.getByRole("button", { name: "Review 1" }));
    expect(list.className).toContain("@max-[40rem]/outbox:hidden");
    expect(detail().className).not.toContain("@max-[40rem]/outbox:hidden");
    fireEvent.click(within(detail()).getByRole("button", { name: "Waiting" }));
    expect(list.className).not.toContain("@max-[40rem]/outbox:hidden");
    expect((screen.getByRole("checkbox", { name: "Tick Send to Sam Ortiz" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });

  it("narrow, shows the list until he picks an item, then the detail with a way back", async () => {
    await open();
    const list = document.querySelector("[data-outbox-list]") as HTMLElement;
    const detail = () => document.querySelector("[data-outbox-detail]") as HTMLElement;
    expect(detail().className).toContain("@max-[40rem]/outbox:hidden");
    fireEvent.click(await screen.findByText("Post message with Slack"));
    expect(list.className).toContain("@max-[40rem]/outbox:hidden");
    expect(detail().className).not.toContain("@max-[40rem]/outbox:hidden");
    fireEvent.click(within(detail()).getByRole("button", { name: "Waiting" }));
    expect(list.className).not.toContain("@max-[40rem]/outbox:hidden");
  });

  it("heads a Teams post as Post in Teams and a Google share by its file, each fact said once, the list keeping the whole summary", async () => {
    const teams: OutboxItem = { ...addonCall, state: "held", ref: { at: "host", id: "tp1" }, kind: "teams.post", workspaceId: "ws1", summary: "Post in Teams to Esports staff: “Spring LAN is set”", verb: "Post", payload: { chat: "Esports staff", text: "Spring LAN is set" } };
    const share: OutboxItem = { ...addonCall, state: "held", ref: { at: "host", id: "gs1" }, kind: "share.google", workspaceId: "ws1", summary: "Share Budget.xlsx with dana@purdue.edu (can edit)", verb: "Share", payload: { account: "landon@x", fileId: "1AbC", name: "Budget.xlsx", email: "dana@purdue.edu", role: "writer", notify: false } };
    world.items.set("box", [mail("o1", "Dana Lee", "Budget"), teams, share]);
    world.items.set("mac", []);
    await open();
    fireEvent.click(screen.getByText("Post in Teams to Esports staff"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Post in Teams"));
    // Esports staff once in the detail: the post's place line, once its view has loaded.
    const detail = document.querySelector("[data-outbox-detail]") as HTMLElement;
    await waitFor(() => expect(detail.textContent!.split("Esports staff").length - 1).toBe(1));
    // The list names who and how first, the file under it.
    fireEvent.click(screen.getByText("Share with dana@purdue.edu (can edit)"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Share Budget.xlsx"));
    await waitFor(() => expect(detail.textContent!.split("dana@purdue.edu").length - 1).toBe(1));
    expect(document.querySelector("[data-outbox-list]")!.textContent).toContain("Budget.xlsx");
    // The list keeps the whole summary.
    expect(document.querySelector("[data-outbox-list]")!.textContent).toContain("Esports staff");
  });

  it("keeps a Google share's person in its list title however long the file's name, the file on the line under it", () => {
    const share = { kind: "share.google", verb: "Share", summary: "Share Spring LAN budget, final, with every vendor quote attached.xlsx with dana@purdue.edu (can edit)", payload: { name: "Spring LAN budget, final, with every vendor quote attached.xlsx", email: "dana@purdue.edu", role: "writer" } } as never;
    expect(rowWords(share)).toEqual({ act: "Share with dana@purdue.edu (can edit)", about: "Spring LAN budget, final, with every vendor quote attached.xlsx" });
    // Every other kind splits its summary at the colon, as before.
    expect(rowWords({ kind: "mail.send", verb: "Send", summary: "Send to Dana Lee: Budget", payload: {} } as never)).toEqual({ act: "Send to Dana Lee", about: "Budget" });
  });

  it("leads an agent's change to a shared file with the file, in the past once made", () => {
    const change = { kind: "office.edit", verb: "Make the change", state: "held", summary: 'Make the change in Spring LAN budget.docx: "$4,180" to "$4,320"', payload: { name: "Spring LAN budget.docx" } } as never;
    expect(rowWords(change)).toEqual({ act: "Change Spring LAN budget.docx", about: '"$4,180" to "$4,320"' });
    expect(rowWords({ ...(change as object), kind: "google.edit", state: "sent" } as never).act).toBe("Changed Spring LAN budget.docx");
    // A file named with ": " keeps the change whole, and several changes lead with their count.
    const deck = { kind: "google.edit", verb: "Make 2 changes", state: "held", summary: 'Make 2 changes in Nationals: travel: "7 AM" to "6:30 AM" and 1 more', payload: { name: "Nationals: travel", edits: [{}, {}] } } as never;
    expect(rowWords(deck)).toEqual({ act: "Change Nationals: travel", about: '2 changes: "7 AM" to "6:30 AM"' });
    // the first change's own reach is the detail's, not the line's beside the count
    const reach = { kind: "google.edit", verb: "Make 2 changes", state: "held", summary: 'Make 2 changes in Plan: 3 boxes, "Q1" to "Q2" and 1 more', payload: { name: "Plan", edits: [{}, {}] } } as never;
    expect(rowWords(reach).about).toBe('2 changes: "Q1" to "Q2"');
  });

  it("says an empty list once at either width: in the list when narrow, in the detail when wide", async () => {
    world.items.set("box", []);
    world.items.set("mac", []);
    resetOutboxStore();
    render(<OutboxView besideRail onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await waitFor(() => expect(screen.getAllByText("Nothing held").length).toBe(2));
    const inList = document.querySelector("[data-outbox-list] [data-outbox-empty=list]") as HTMLElement;
    const inDetail = document.querySelector("[data-outbox-detail] [data-outbox-empty=detail]") as HTMLElement;
    // The list's copy shows only under 640px, where the detail (and its copy) is hidden: one on screen at either width.
    expect(inList.className).toContain("hidden");
    expect(inList.className).toContain("@max-[40rem]/outbox:flex");
    expect((document.querySelector("[data-outbox-detail]") as HTMLElement).className).toContain("@max-[40rem]/outbox:hidden");
    expect(inDetail.textContent).toContain("Nothing held");
  });

  it("never says Nothing held beside a host whose list failed: it names the host and says nothing is known", async () => {
    world.namedHosts = true;
    world.items.set("box", []);
    world.items.set("mac", []);
    world.listDown.add("mac");
    resetOutboxStore();
    render(<OutboxView besideRail onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await waitFor(() => expect(screen.getAllByText("Not known yet").length).toBe(2));
    expect(screen.queryByText("Nothing held")).toBeNull();
    // The named failure and its Retry stay in view.
    const failure = [...document.querySelectorAll("[role=status]")].find((n) => n.textContent?.includes("The connection to Mac dropped"))!;
    expect(failure.querySelector("button")!.textContent).toContain("Retry");
    // The row above is the one place that names the host: the empty words do not name it again.
    const empty = document.querySelector("[data-outbox-detail] [data-outbox-empty=detail]") as HTMLElement;
    expect(empty.textContent).toContain("Shown once it answers.");
    expect(empty.textContent).not.toContain("did not answer");
    // Once it answers, the empty list is known to be clear.
    world.listDown.clear();
    const { loadOutbox } = await import("./store");
    await act(async () => loadOutbox());
    await waitFor(() => expect(screen.getAllByText("Nothing held").length).toBe(2));
  });

  it("with two hosts down, the empty words say once they answer", async () => {
    world.items.set("box", []);
    world.items.set("mac", []);
    world.listDown.add("box");
    world.listDown.add("mac");
    resetOutboxStore();
    render(<OutboxView besideRail onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await waitFor(() => expect(screen.getAllByText("Shown once they answer.").length).toBe(2));
    expect(screen.queryByText("Nothing held")).toBeNull();
  });

  it("a send that answers late moves nothing off what he picked since, or off Sent", async () => {
    await open();
    const list = () => document.querySelector("[data-outbox-list]") as HTMLElement;
    const picked = () => list().querySelector("[aria-current=true]")?.textContent ?? "";
    const pressLate = async () => {
      let answer!: () => void;
      world.sendHeld = new Promise<void>((resolve) => (answer = resolve));
      await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sends().length).toBeGreaterThan(0));
      return answer;
    };
    // He sends Dana's mail, then picks Events booking before the host answers: he stays on Events booking.
    let answer = await pressLate();
    fireEvent.click(within(list()).getByText("Send to Events booking"));
    await act(async () => answer());
    await waitFor(() => expect(within(list()).queryByText("Send to Dana Lee")).toBeNull());
    expect(picked()).toContain("Send to Events booking");
    // He sends Events booking and goes to Sent before the answer: Sent keeps its own pick, its detail on screen.
    answer = await pressLate();
    fireEvent.click(screen.getByRole("tab", { name: "Done" }));
    await act(async () => answer());
    await waitFor(() => expect(within(list()).getAllByText("Sent to Events booking").length).toBeGreaterThan(0));
    await waitFor(() => expect(picked()).not.toBe(""));
    expect(screen.queryByText("No longer waiting")).toBeNull();
    // With nothing picked since, a send still hands the selection to the next one down.
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    world.sendHeld = null;
    await waitFor(() => expect(picked()).toContain("Send to Sam Ortiz"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    await waitFor(() => expect(picked()).toContain("Post message with Slack"));
  });

  it("narrow, the summary row keeps its act and its side word, and leaves what it is about to the row opened in place", async () => {
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick Send to Sam Ortiz" }));
    fireEvent.click(screen.getByRole("button", { name: "Review 1" }));
    const row = document.querySelector("[data-summary-row]") as HTMLElement;
    expect(row.querySelector("[data-summary-act]")!.textContent).toBe("Send to Sam Ortiz");
    expect(row.querySelector("[data-summary-about]")!.className).toContain("@max-[28rem]/summary:hidden");
    fireEvent.click(within(row).getByRole("button", { name: "Open Send to Sam Ortiz" }));
    await waitFor(() => expect(row.querySelector("[data-summary-open]")!.textContent).toContain("Scrims"));
  });
});

describe("a grant he has earned", () => {
  const offer = (from: OutboxItem): GrantOffer => ({ id: "go_1", workspaceId: "ws1", kind: "mail.send", label: "Mail to Dana Lee", routineId: null, from: from.ref, count: 5, createdAt: 2_000 });
  const sentDana = () => {
    const item = world.items.get("box")![0]!;
    Object.assign(item, { state: "sent", decidedBy: "owner", decidedAt: 2_000 });
    return item;
  };
  async function openSent() {
    render(<OutboxView besideRail onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Done" }));
    await waitFor(() => expect(screen.getAllByText("Sent to Dana Lee").length).toBeGreaterThan(0), { timeout: 5000 });
  }

  it("waits under the sent item that completed the run; Stop holding names only the offer, and the line turns to the grant with Undo", async () => {
    world.offers.set("box", [offer(sentDana())]);
    await openSent();
    const line = await waitFor(() => document.querySelector("[data-offer-line]") as HTMLElement);
    expect(line.textContent).toContain("Mail to Dana Lee: you sent the last 5 as written.");
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Stop holding" })));
    expect(world.calls.filter((c) => c.method === "work.outbox.takeOffer").map((c) => c.params)).toEqual([{ id: "go_1" }]);
    // never a grant made from a matcher the screen chose
    expect(world.calls.some((c) => c.method === "work.outbox.grant")).toBe(false);
    await waitFor(() => expect(document.querySelector("[data-offer-line]")?.textContent).toContain("Grant made: Mail to Dana Lee"));
    await act(async () => fireEvent.click(within(document.querySelector("[data-offer-line]") as HTMLElement).getByRole("button", { name: "Undo" })));
    expect(world.calls.filter((c) => c.method === "work.outbox.ungrant")).toHaveLength(1);
    await waitFor(() => expect(document.querySelector("[data-offer-line]")).toBeNull());
  });

  it("is not shown to a given computer's key, which may not make grants", async () => {
    testKey.current = GIVEN_KEY;
    world.offers.set("box", [offer(sentDana())]);
    await openSent();
    // the offers are read with the list: by now an owner's window shows the line (the test above)
    await waitFor(() => expect(world.calls.some((c) => c.method === "work.outbox.offers")).toBe(true));
    await act(async () => undefined);
    expect(document.querySelector("[data-offer-line]")).toBeNull();
  });

  it("Dismiss is for good, and an item that completed no run shows no line", async () => {
    world.offers.set("box", [offer(sentDana())]);
    Object.assign(world.items.get("box")![1]!, { state: "sent", decidedBy: "owner", decidedAt: 1_500 });
    await openSent();
    const line = await waitFor(() => document.querySelector("[data-offer-line]") as HTMLElement);
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Dismiss" })));
    expect(world.calls.filter((c) => c.method === "work.outbox.dismissOffer").map((c) => c.params)).toEqual([{ id: "go_1" }]);
    await waitFor(() => expect(document.querySelector("[data-offer-line]")).toBeNull());
    fireEvent.click(screen.getByText("Sent to Sam Ortiz"));
    expect(document.querySelector("[data-offer-line]")).toBeNull();
  });

  it("a press that completed a run says so in its toast, whose Review opens the item in Sent with the offer beside it", async () => {
    const { Toaster } = await import("../../components/ui/toaster");
    render(<Toaster />);
    await open();
    // the host makes the offer before the press answers
    const send = world.calls.length;
    await act(async () => {
      world.offers.set("box", [offer(world.items.get("box")![0]!)]);
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(world.calls.slice(send).map((c) => c.method)).toContain("work.outbox.offers");
    const review = await screen.findByRole("button", { name: "Review" }, { timeout: 5000 });
    expect(document.body.textContent).toContain("Mail to Dana Lee: you sent the last 5 as written.");
    await act(async () => fireEvent.click(review));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Done" }).getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(document.querySelector("[data-offer-line]")?.textContent).toContain("Mail to Dana Lee"));
  });
});

describe("the Outbox, rebuilt around how he decides", () => {
  const detail = () => document.querySelector("[data-outbox-detail]") as HTMLElement;
  const page = () => document.querySelector("[data-work-outbox]") as HTMLElement;
  const picked = () => document.querySelector('[data-outbox-list] [aria-current="true"]')?.textContent ?? "";

  it("orders Waiting: Not sent, Starts soon, each thread's group, then Scheduled", async () => {
    const soon = Date.now() + 3 * 3_600_000;
    world.items.set("box", [
      mail("o1", "Dana Lee", "Budget"),
      mail("o2", "Sam Ortiz", "Scrims", { state: "failed", error: "Gmail refused it" }),
      { ...mail("o3", "Kickoff", "call"), ref: { at: "lifeos", table: "calendarOps", id: "o3" }, kind: "calendar.op", summary: "Accept Kickoff call with Northside PT", verb: "Accept", payload: { id: "o3", kind: "accept", eventStartsAt: soon } },
      mail("o4", "Jess", "Trailer", { state: "scheduled", scheduledFor: Date.now() + 86_400_000, scheduledZone: "America/Chicago" }),
    ]);
    await open();
    const kinds = [...document.querySelectorAll("[data-outbox-section]")].map((s) => s.getAttribute("data-outbox-section"));
    expect(kinds).toEqual(["failed", "soon", "thread", "thread", "scheduled"]);
    const headings = [...document.querySelectorAll("[data-outbox-section]")].map((s) => s.getAttribute("aria-label"));
    expect(headings[0]).toBe("Not sent");
    expect(headings[1]).toBe("Starts soon");
    expect(headings.at(-1)).toBe("Scheduled");
    // The start is the row's word, in the foreground.
    const start = document.querySelector('[data-outbox-section="soon"] li span.text-foreground');
    expect(start?.textContent).toMatch(/\d:\d\d [AP]M/);
  });

  it("folds a group over five to four rows and N more", async () => {
    world.items.set("box", Array.from({ length: 7 }, (_, i) => mail(`o${i + 1}`, `Player ${i + 1}`, "Nationals travel")));
    world.items.set("mac", []);
    render(<OutboxView besideRail onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await waitFor(() => expect(screen.getByText("3 more")).toBeTruthy(), { timeout: 5000 });
    expect(document.querySelectorAll("[data-outbox-waiting] li")).toHaveLength(5);
    // The fold is laid out as a row: its words on the rows' 28px edge, its chevron in the glyph column (council R1-A22).
    const fold = screen.getByText("3 more").closest("button")!;
    expect(fold.className).toContain("ps-7");
    expect(fold.querySelector("svg")).toBeNull();
    expect(fold.parentElement!.querySelector("[data-fold-chevron]")!.className).toContain("start-2");
    fireEvent.click(screen.getByText("3 more"));
    expect(document.querySelectorAll("[data-outbox-waiting] li")).toHaveLength(7);
    expect(screen.getByRole("button", { name: "Select 7" })).toBeTruthy();
  });

  it("is one tab stop: the picked row; J and K, and the arrows, move the pick and the focus together", async () => {
    await open();
    const stops = [...document.querySelectorAll("[data-outbox-row]")].filter((r) => r.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    const first = picked();
    fireEvent.keyDown(page(), { key: "j" });
    await waitFor(() => expect(picked()).not.toBe(first));
    expect(document.activeElement?.getAttribute("aria-current")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    await waitFor(() => expect(picked()).toBe(first));
    fireEvent.keyDown(document.activeElement!, { key: "k" });
    expect(picked()).toBe(first);
  });

  /** The live walk (S9): at 1,024px the Outbox is narrow, and the first ↓ opened the item over the list, so focus went to a hidden row and the keys stopped. */
  it("keeps a narrow page's list under the keys: the arrows move the pick, they open nothing over the list", async () => {
    await open();
    const list = () => document.querySelector<HTMLElement>("[data-outbox-list]")!;
    const first = picked();
    fireEvent.keyDown(page(), { key: "ArrowDown" });
    await waitFor(() => expect(picked()).not.toBe(first));
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    expect(list().className).not.toContain("@max-[40rem]/outbox:hidden");
    expect(document.querySelector("[data-outbox-detail]")!.className).toContain("@max-[40rem]/outbox:hidden");
    expect(document.activeElement?.closest("[data-outbox-row]")).toBeTruthy();
  });

  it("X ticks the row, Shift+X ticks the range from the last tick, Escape clears the ticks before it closes the page", async () => {
    const closed = vi.fn();
    render(<OutboxView besideRail onClose={closed} />);
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await waitFor(() => expect(screen.getAllByText("Send to Dana Lee").length).toBeGreaterThan(0), { timeout: 5000 });
    fireEvent.keyDown(page(), { key: "x" });
    await waitFor(() => expect(document.querySelector("[data-outbox-summary]")).toBeTruthy());
    expect(document.querySelectorAll("[data-summary-row]")).toHaveLength(1);
    // The pick stays put while ticking: the keys move the focus alone.
    fireEvent.keyDown(page(), { key: "j" });
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    fireEvent.keyDown(document.activeElement!, { key: "X", shiftKey: true });
    await waitFor(() => expect(document.querySelectorAll("[data-summary-row]")).toHaveLength(3));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.querySelector("[data-outbox-summary]")).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? page(), { key: "Escape" });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("the command key and Enter press the primary verb; E edits; D opens Discard's field", async () => {
    await open();
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.keyDown(page(), { key: "e" });
    expect(document.querySelector("[data-outbox-editing]")).toBeTruthy();
    fireEvent.keyDown(document.querySelector("[data-outbox-detail] h1")!, { key: "Escape" });
    fireEvent.keyDown(page(), { key: "d" });
    expect(await screen.findByRole("textbox", { name: "Why, for the thread" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Why, for the thread" }), { key: "Escape" });
    await act(async () => fireEvent.keyDown(page(), { key: "Enter", metaKey: true }));
    await act(async () => fireEvent.keyDown(page(), { key: "Enter", ctrlKey: true }));
    expect(sends().length).toBe(1);
  });

  it("says in one sentence what the press does, over the thing", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { effect: "Goes from landon@purdue.edu to Dana Lee after your 30-second undo." })]);
    await open();
    const head = detail().querySelector("header")!;
    // Only what the fields below do not say: From and To are the mail's own.
    expect(head.nextElementSibling!.textContent).toBe("Goes after your 30-second undo.");
  });

  it("an item out of date waits with its why; its bar is Discard and Ask the thread again", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { state: "stale", error: "Dana changed the sheet at 9:05 AM, after this was made." })]);
    await open();
    expect(screen.getAllByText("Out of date").length).toBeGreaterThan(0);
    await waitFor(() => expect(detail().textContent).toContain("Out of date. Dana changed the sheet at 9:05 AM, after this was made."));
    expect(within(detail()).queryByRole("button", { name: "Send" })).toBeNull();
    await act(async () => fireEvent.click(within(detail()).getByRole("button", { name: "Ask the thread again" })));
    expect(world.calls.filter((c) => c.method === "work.outbox.askAgain").map((c) => c.params)).toEqual([{ ref: { at: "lifeos", table: "outbox", id: "o1" } }]);
  });

  it("an item the thread rewrote says so, Changed in its row, and Show changes draws the words out and in", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { changed: { at: Date.now() - 600_000, by: "thread" } })]);
    world.extra = { o1: { changed: { at: Date.now() - 600_000, by: "thread", first: { message: { to: [{ name: "Dana Lee", address: "dana@purdue.edu" }], subject: "Budget", text: "Hello Dana Lee,\n\nAbout it.\n\nLandon" } } } } };
    await open();
    expect(screen.getAllByText("Changed").length).toBeGreaterThan(0);
    const show = await within(detail()).findByRole("button", { name: "Show changes" });
    expect(detail().textContent).toMatch(/The thread rewrote this at /);
    // A 20px link line, its press 24px tall (council R2-A5).
    expect(show.className).toContain("after:-inset-y-0.5");
    fireEvent.click(show);
    const changes = detail().querySelector("[data-outbox-changes]")!;
    expect(changes.querySelector("ins")!.textContent).toContain("Budget.");
    expect(changes.querySelector("del")!.textContent).toContain("it.");
    expect(within(detail()).getByRole("button", { name: "Hide changes" })).toBeTruthy();
  });

  it("a mail whose person wrote back since says who, when and their first line", async () => {
    world.extra = { o1: { replied: { from: "Dana Lee", at: Date.now() - 60_000, line: "Can we move it to 3?" } } };
    await open();
    await waitFor(() => expect(detail().textContent).toMatch(/Dana Lee wrote back at .+, after this was made: “Can we move it to 3\?”/));
  });

  it("offers Send later on Send's menu only for a kind that may wait, above the grant", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { later: true })]);
    await open();
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "More ways to send" }));
    const items = (await screen.findAllByRole("menuitem")).map((m) => m.childNodes[0]!.textContent!.trim());
    expect(items).toEqual(["In an hour", "This afternoon", "Tomorrow morning", "Pick a time…", "Mail to Dana Lee"].filter((x) => x !== "This afternoon" || new Date().getHours() < 12));
    await act(async () => fireEvent.click(screen.getAllByRole("menuitem")[0]!));
    expect(world.decides.at(-1)!.items[0]).toMatchObject({ ref: { id: "o1" }, do: "later", rev: 500 });
  });

  it("a timed send leads with the zone he named it in, this window's after", async () => {
    const { effectWords } = await import("./HeldDetail");
    const { ownZone, scheduleLine } = await import("work-kit/mail/lib/zones");
    const at = Date.now() + 86_400_000;
    const words = effectWords({ kind: "mail.send", state: "scheduled", scheduledFor: at, scheduledZone: "Pacific/Auckland", effect: null } as never);
    expect(words).toBe(`Goes ${scheduleLine(at, "Pacific/Auckland", ownZone())}.`);
    expect(words).not.toBe(`Goes ${scheduleLine(at, ownZone(), "Pacific/Auckland")}.`);
    expect(effectWords({ kind: "mail.send", state: "scheduled", scheduledFor: at, scheduledZone: "Pacific/Auckland", effect: "Sends as you." } as never)).toBe(`Goes ${scheduleLine(at, "Pacific/Auckland", ownZone())}. Sends as you.`);
  });

  it("a scheduled item goes in Scheduled, says when, and its bar is Cancel send and Send now", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { state: "scheduled", scheduledFor: Date.now() + 86_400_000, scheduledZone: "America/Chicago" })]);
    await open();
    // The first row to land is picked by itself; which host answers first is not the test's.
    fireEvent.click(screen.getAllByText("Send to Dana Lee").find((el) => el.closest("li"))!);
    await waitFor(() => expect(detail().textContent).toMatch(/Goes /));
    await act(async () => fireEvent.click(within(detail()).getByRole("button", { name: "Send now" })));
    expect(world.calls.some((c) => c.method === "work.outbox.sendNow")).toBe(true);
  });

  it("Cancel send puts a scheduled item back as held", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { state: "scheduled", scheduledFor: Date.now() + 86_400_000 })]);
    await open();
    // The first row to land is picked by itself; which host answers first is not the test's.
    fireEvent.click(screen.getAllByText("Send to Dana Lee").find((el) => el.closest("li"))!);
    await act(async () => fireEvent.click(within(detail()).getByRole("button", { name: "Cancel send" })));
    expect(world.calls.filter((c) => c.method === "work.outbox.cancelSend")).toHaveLength(1);
    expect(world.calls.some((c) => c.method === "work.mail.cancel")).toBe(false);
  });

  it("a LifeOS mail's toast takes it back with Undo while LifeOS holds it", async () => {
    world.sendSaid = { o1: "queued" };
    const plain = vi.fn();
    const spy = vi.spyOn(await import("../../components/ui/toaster"), "loadToast").mockResolvedValue(Object.assign(plain, { error: vi.fn() }) as never);
    try {
      await open();
      await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
      await waitFor(() => expect(plain).toHaveBeenCalled());
      const [line, opts] = plain.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
      expect(line).toBe("Queued in LifeOS: Budget");
      expect(opts.action.label).toBe("Undo");
      await act(async () => opts.action.onClick());
      expect(world.calls.filter((c) => c.method === "work.outbox.undoSend").map((c) => c.params)).toEqual([{ ref: { at: "lifeos", table: "outbox", id: "o1" } }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("says nothing of a thread whose title it does not know, rather than a bare from", async () => {
    const opened = vi.fn();
    render(<OutboxView besideRail onClose={() => undefined} onOpenSession={opened} />);
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await waitFor(() => expect(screen.getAllByText("Send to Dana Lee").length).toBeGreaterThan(0), { timeout: 5000 });
    // The row can land before the detail. Wait for its facts before checking the missing thread title.
    await waitFor(() => {
      const header = detail().querySelector("header");
      expect(header).not.toBeNull();
      expect(header!.textContent).not.toMatch(/from\s*$/);
    }, { timeout: 5000 });
  });
});

describe("a thread's request in the Outbox", () => {
  const asking = () => ({
    id: "r1",
    n: 3,
    sessionId: "t1",
    workspaceId: "ws1",
    sector: "purdue",
    quote: "send Dana's and Sam's mails",
    head: "Send 2 mails",
    state: "open",
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 86_400_000,
    answeredBy: null,
    answeredAt: null,
    rows: ["o1", "o2"].map((id) => ({ ref: { at: "lifeos", table: "outbox", id }, do: "send", item: world.items.get("box")!.find((i) => i.ref.id === id), changed: false, open: true, receipt: `rc-${id}` })),
  });

  it("leads Waiting with Asked in threads, one row a request, and lists its items under it alone", async () => {
    world.requests.set("box", [asking()]);
    render(<OutboxView besideRail onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await waitFor(() => expect(document.querySelector('[data-outbox-section="asked"]')).toBeTruthy(), { timeout: 5000 });
    const sections = [...document.querySelectorAll("[data-outbox-section]")];
    expect(sections[0]!.getAttribute("data-outbox-section")).toBe("asked");
    expect(sections[0]!.querySelectorAll("li")).toHaveLength(1);
    expect(sections[0]!.textContent).toContain("Send 2 mails to 2 people");
    // Dana's and Sam's mails are the request's; only the third still sits under its thread.
    const rest = sections.slice(1).map((s) => s.textContent).join(" ");
    expect(rest).not.toContain("Send to Dana Lee");
    expect(rest).not.toContain("Send to Sam Ortiz");
    expect(rest).toContain("Send to Events booking");
    // Its detail is the same summary, with Not now and Send 2.
    fireEvent.click(within(sections[0] as HTMLElement).getByText("Send 2 mails to 2 people"));
    const detail = document.querySelector("[data-outbox-detail]") as HTMLElement;
    await waitFor(() => expect(within(detail).getByRole("button", { name: "Send 2" })).toBeTruthy());
    expect(within(detail).getByRole("button", { name: "Not now" })).toBeTruthy();
    expect(detail.textContent).toContain("You asked: “send Dana's and Sam's mails”");
    await act(async () => fireEvent.keyDown(document.querySelector("[data-work-outbox]")!, { key: "Enter", ctrlKey: true, metaKey: false }));
    await act(async () => fireEvent.keyDown(document.querySelector("[data-work-outbox]")!, { key: "Enter", metaKey: true, ctrlKey: false }));
    expect(world.calls.filter((c) => c.method === "work.outbox.decide").map((c) => c.params)).toEqual([{ request: "r1", receipts: ["rc-o1", "rc-o2"] }]);
  });

  it("an untouched page picks a request that comes to lead, though the items came first", async () => {
    rememberOutboxTab("waiting");
    render(<OutboxView besideRail onClose={() => undefined} />);
    await waitFor(() => expect(screen.getAllByText("Send to Dana Lee").length).toBeGreaterThan(0), { timeout: 5000 });
    world.requests.set("box", [asking()]);
    const { loadRequests } = await import("./requests");
    await act(async () => loadRequests("box"));
    await waitFor(() => expect(within(document.querySelector("[data-outbox-detail]") as HTMLElement).getByRole("button", { name: "Send 2" })).toBeTruthy());
  });

  it("opens on an item asked for by its host's number, as the transcript's held line asks", async () => {
    wantOutboxItem({ environmentId: "mac", n: 1 });
    render(<OutboxView besideRail onClose={() => undefined} />);
    await waitFor(() => expect(document.querySelector('[data-outbox-list] [aria-current="true"]')?.textContent).toContain("Post message with Slack"), { timeout: 5000 });
  });
});

describe("council round 1: the list, the detail and the bulk press", () => {
  it("puts 12px between groups on the section, none over the first", async () => {
    await open();
    const sections = [...document.querySelectorAll("[data-outbox-section]")];
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) expect(section.className.split(" ")).toEqual(expect.arrayContaining(["mt-3", "first:mt-0"]));
  });

  it("keeps the trailing word in its column when what it is about hides, and lets it give way first on a very narrow row", async () => {
    await open();
    const side = screen.getAllByText("Send to Dana Lee").find((el) => el.closest("li"))!.closest("button")!.lastElementChild!;
    expect(side.className).toContain("ms-auto");
    expect(side.className).toContain("@max-[15rem]/row:hidden");
  });

  it("keeps the page's name over Grants when the header is narrow", async () => {
    await open();
    expect(screen.getByText("Outbox", { selector: "span" }).className).toContain("shrink-0");
    expect(screen.getByRole("button", { name: "Grants" }).className).toContain("@max-[18rem]/head:hidden");
  });

  it("says Done's outcome in the trailing slot, where it holds at every width", async () => {
    world.items.set("box", [mail("o2", "Sam Ortiz", "Scrims", { state: "discarded", decidedBy: "owner", decidedAt: Date.now() - 60_000 })]);
    world.items.set("mac", []);
    rememberOutboxTab("done");
    render(<OutboxView besideRail onClose={() => undefined} />);
    const row = await waitFor(() => screen.getByText("Send to Sam Ortiz").closest("button")!, { timeout: 5000 });
    expect(row.lastElementChild!.textContent).toBe("Discarded");
    expect(row.textContent).toContain("Scrims");
  });

  it("a bulk press's Send again leaves out a row that may have gone: that one is checked in its own detail", async () => {
    world.refuse = { o2: "Outlook did not answer in time" };
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Select 3" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send 3" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send 1 again" })).toBeTruthy(), { timeout: 5000 });
    Object.assign(world.items.get("box")!.find((i) => i.ref.id === "o2")!, { state: "failed", outcomeUnknown: true });
    await act(async () => loadOutbox());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send 1 again" })).toBeNull());
  });
});

describe("the bulk press's Send again is bound to the revision its result shows (review round 5, finding 6)", () => {
  it("a failed row whose words changed after its result opens the item's detail, and nothing is sent", async () => {
    world.refuse = { o2: "Outlook did not answer in time" };
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Select 3" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send 3" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send 1 again" })).toBeTruthy(), { timeout: 5000 });
    // The thread rewrites Sam's mail while the old result is on screen.
    Object.assign(world.items.get("box")!.find((i) => i.ref.id === "o2")!, { state: "held", updatedAt: 900 });
    await act(async () => loadOutbox());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send 1 again" })).toBeNull());
    const decides = world.decides.length;
    fireEvent.click(screen.getByRole("button", { name: "Open in the Outbox" }));
    // The item's own detail, with its new words, and no press made.
    await waitFor(() => expect(document.querySelector("[data-outbox-detail] h1")?.textContent).toBe("Send to Sam Ortiz"));
    expect(document.querySelector("[data-outbox-summary]")).toBeNull();
    expect(world.decides.length).toBe(decides);
  });

  it("a failed row whose item still stands as its result showed goes again with that revision", async () => {
    world.refuse = { o2: "Outlook did not answer in time" };
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Select 3" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send 3" })));
    world.refuse = {};
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Send 1 again" })));
    expect(world.decides.at(-1)!.items).toEqual([{ ref: { at: "lifeos", table: "outbox", id: "o2" }, do: "send", rev: 500 }]);
  });
});

describe("council round 2: the detail and the list", () => {
  it("Show changes marks the change in the thing's own slot, the body drawn once, a gap between what went and what came", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { changed: { at: Date.now() - 600_000, by: "thread" } })]);
    world.extra = { o1: { changed: { at: Date.now() - 600_000, by: "thread", first: { message: { to: [{ name: "Dana Lee", address: "dana@purdue.edu" }], subject: "Budget", text: "Hello Dana Lee,\n\nAbout it.\n\nLandon" } } } } };
    await open();
    const detail = document.querySelector("[data-outbox-detail]") as HTMLElement;
    fireEvent.click(await within(detail).findByRole("button", { name: "Show changes" }));
    const changes = detail.querySelector("[data-outbox-changes]")!;
    // The body once: in the changes' place, not again under the fields.
    expect((detail.textContent!.match(/Landon/g) ?? []).length).toBe(1);
    expect(detail.querySelectorAll('[data-slot="act-payload"]')).toHaveLength(1);
    const del = changes.querySelector("p del")!;
    expect(del.nextElementSibling?.tagName).toBe("INS");
    expect(del.className).toContain("me-1");
  });

  it("Show changes keeps Send on, reads in the mail's order with each address muted, and keeps its files", async () => {
    world.items.set("box", [
      mail("o1", "Dana Lee", "Budget", {
        changed: { at: Date.now() - 600_000, by: "thread" },
        payload: { id: "o1", message: { kind: "mail", from: { address: "landon@purdue.edu" }, to: [{ name: "Dana Lee", address: "dana@purdue.edu" }], subject: "Budget", text: "Hi Dana,\n\nAbout it.\n\nLandon", attachments: [{ name: "budget.xlsx" }] } },
      }),
    ]);
    world.extra = { o1: { changed: { at: Date.now() - 600_000, by: "thread", first: { message: { to: [{ name: "Dana Lee", address: "dana@purdue.edu" }], subject: "Budget", text: "Hello Dana,\n\nAbout it.\n\nLandon" } } } } };
    await open();
    const detail = document.querySelector("[data-outbox-detail]") as HTMLElement;
    const send = () => within(detail).getAllByRole("button").find((b) => /^Send$/.test(b.textContent ?? ""))!;
    await waitFor(() => expect(send().hasAttribute("disabled")).toBe(false));
    fireEvent.click(await within(detail).findByRole("button", { name: "Show changes" }));
    const changes = detail.querySelector("[data-outbox-changes]")!;
    expect([...changes.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["From", "To", "Subject"]);
    const to = [...changes.querySelectorAll("dd")][1]!;
    expect(to.textContent).toBe("Dana Lee dana@purdue.edu");
    expect(to.querySelector(".text-muted-foreground")?.textContent).toBe("dana@purdue.edu");
    expect(changes.textContent).toContain("budget.xlsx");
    expect(send().hasAttribute("disabled")).toBe(false);
  });

  it("a failure that will repeat leads with its refusal and makes Edit the primary press, Send again stepping down", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { state: "failed", error: "LifeOS refused the send: the attachment is over 25 MB", effect: "Goes from landon@purdue.edu to Dana Lee after your 30-second undo." })]);
    world.items.set("mac", []);
    await open();
    const detail = document.querySelector("[data-outbox-detail]") as HTMLElement;
    const head = detail.querySelector("header")!;
    expect(head.nextElementSibling!.textContent).toMatch(/^Not sent\./);
    const edit = within(detail).getByRole("button", { name: "Edit" });
    expect(edit.getAttribute("data-variant")).toBe("default");
    // Send again sits in the fix's menu, one click away, so the bar fits a narrow window.
    expect(within(detail).queryByRole("button", { name: "Send again" })).toBeNull();
    fireEvent.click(within(detail).getByRole("button", { name: "More: Send again" }));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Send again" })));
    await waitFor(() => expect(sends().length).toBe(1));
  });

  it("a refusal of its files makes Open the thread the primary press where the thread can fix it", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { state: "failed", sessionId: "s1", error: "Gmail refused it: the attachment is over 25 MB." })]);
    world.items.set("mac", []);
    const opened: string[] = [];
    await open((id) => opened.push(id));
    const detail = document.querySelector("[data-outbox-detail]") as HTMLElement;
    const thread = within(detail).getByRole("button", { name: "Open the thread" });
    expect(thread.getAttribute("data-variant")).toBe("default");
    expect(within(detail).getByRole("button", { name: "Edit" }).getAttribute("data-variant")).toBe("secondary");
    expect(within(detail).getByRole("button", { name: "More: Send again" })).toBeTruthy();
    fireEvent.click(thread);
    expect(opened).toEqual(["s1"]);
  });

  it("while rows are ticked a failed row keeps its red mark until it is ticked itself", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget"), mail("o2", "Sam Ortiz", "Rota", { state: "failed", error: "Outlook did not answer in time" })]);
    world.items.set("mac", []);
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick Send to Dana Lee" }));
    const failedBox = screen.getByRole("checkbox", { name: "Tick Send to Sam Ortiz" });
    // The row's lead: the 16px box that holds its red mark.
    const lead = (box: HTMLElement) => [...(box.closest("li")?.querySelectorAll<HTMLElement>("span.size-4") ?? [])].filter((el) => el.querySelector('[data-slot="status-glyph"]')).at(-1) ?? null;
    await waitFor(() => expect(lead(failedBox)).not.toBeNull());
    expect(lead(failedBox)!.classList.contains("opacity-0")).toBe(false);
    fireEvent.click(failedBox);
    await waitFor(() => expect(lead(failedBox)?.classList.contains("opacity-0")).toBe(true));
  });

  it("a failure that may clear keeps Send again as the primary press", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { state: "failed", error: "Outlook did not answer in time" })]);
    world.items.set("mac", []);
    await open();
    const detail = document.querySelector("[data-outbox-detail]") as HTMLElement;
    await waitFor(() => expect(within(detail).getByRole("button", { name: "Send again" }).getAttribute("data-variant")).toBe("default"));
    expect(within(detail).getByRole("button", { name: "Edit" }).getAttribute("data-variant")).toBe("secondary");
  });

  it("rows that share an act keep what tells them apart, and their time", async () => {
    const echo = (id: string, post: string) => ({ ...addonCall, ref: { at: "host" as const, id }, workspaceId: "ws1", summary: `Echo with League: ${post}` });
    world.items.set("box", [echo("e1", "Roster post 11"), echo("e2", "Roster post 12")]);
    world.items.set("mac", []);
    await open().catch(() => undefined);
    const row = await waitFor(() => screen.getByText("Roster post 11").closest("button")!, { timeout: 5000 });
    expect(screen.getByText("Roster post 11").className).not.toContain("@max-[40rem]/outbox:hidden");
    // The time keeps its column at every width but a very narrow row's.
    expect(row.lastElementChild!.className).not.toContain("@max-[30rem]/row:hidden");
    expect(row.lastElementChild!.className).toContain("@max-[15rem]/row:hidden");
  });
});
