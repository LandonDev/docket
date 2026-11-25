// @vitest-environment jsdom
/**
 * A thread's request for his press (docs/DESIGN.md "A thread's request"): the card under the thread's
 * `outbox_request` call, drawn from its host as `work.outbox.request.get` answers, in every state the plan names
 * (waiting, one opened, sending, done with a failure, Not now, void, refused), and never in the warning colour.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxItem, OutboxRequest } from "@shared/contract-work-outbox";

const world = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  request: null as unknown as OutboxRequest,
  // the answer decide gives, made from the request it is asked about
  answer: null as ((r: OutboxRequest, receipts: string[]) => OutboxRequest) | null,
  hold: null as Promise<void> | null,
  // what the host's Outbox lists as waiting (a failed row retried from the card must still be there, as drawn)
  waiting: [] as OutboxItem[],
}));

vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "box",
    connected: true,
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls.push({ method, params });
      switch (method) {
        case "work.outbox.request.get":
          return world.request;
        case "work.outbox.requests":
          return { requests: [] };
        case "work.outbox.request.view": {
          const ref = params.ref as { id: string };
          const row = world.request.rows.find((r) => r.ref.id === ref.id)!;
          return { ...row, receipt: `fresh-${ref.id}` };
        }
        case "work.outbox.decide":
          if (world.hold) await world.hold;
          if (params.request) return { request: world.answer!(world.request, params.receipts as string[]) };
          return { results: (params.items as { ref: { id: string } }[]).map((d) => ({ ref: d.ref, ok: true, item: { ...item(d.ref.id), state: "sent" } })) };
        case "work.outbox.decline":
          return { ...world.request, state: "declined", answeredBy: "owner", answeredAt: Date.now() };
        case "work.outbox.list":
          return params.show === "done" ? { items: [] } : { items: world.waiting, waiting: world.waiting.length };
        case "work.outbox.grants":
          return { grants: [] };
        case "work.outbox.offers":
          return { offers: [] };
        case "work.outbox.get":
          return item((params.ref as { id: string }).id);
      }
      throw new Error(`unknown ${method}`);
    },
  };
  return {
    ...(await original<typeof import("../../lib/connection")>()),
    registry: { linkOf: () => link, onLink: () => () => undefined },
  };
});

import { OutboxRequestRow, pressLabel, refusalWords, requestOfBlock } from "./RequestCard";
import { getRequest } from "./requests";
import { resetOutboxStore } from "./store";
import { wantedOutbox, wantOutbox } from "../../lib/outboxWant";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import type { Block } from "../../lib/session";

function item(id: string, over: Partial<OutboxItem> = {}): OutboxItem {
  const to = { m1: "Alex Kim", m2: "Jordan Patel", m3: "Riley Chen" }[id] ?? "Sam Ortiz";
  return {
    ref: { at: "lifeos", table: "outbox", id },
    kind: "mail.send",
    workspaceId: "ws1",
    sessionId: "t1",
    sector: "purdue",
    summary: `Send to ${to}: Nationals travel`,
    verb: "Send",
    account: "landon@purdue.edu",
    state: "held",
    payload: { message: { to: [{ name: to, address: `${id}@purdue.edu` }], subject: "Nationals travel", text: "Bus at 7.\n\nLandon" } },
    createdAt: 1_000,
    decidedBy: null,
    decidedAt: null,
    n: null,
    why: "lifeos",
    grantId: null,
    error: null,
    result: null,
    routineRunId: null,
    updatedAt: 500,
    ...over,
  };
}

const request = (over: Partial<OutboxRequest> = {}): OutboxRequest => ({
  id: "r1",
  n: 3,
  sessionId: "t1",
  workspaceId: "ws1",
  sector: "purdue",
  quote: "send the roster mails, all three",
  head: "Send 3 mails",
  state: "open",
  createdAt: Date.now() - 60_000,
  expiresAt: Date.now() + 86_400_000,
  answeredBy: null,
  answeredAt: null,
  rows: [
    { ref: { at: "lifeos", table: "outbox", id: "m1" }, do: "send", item: item("m1"), changed: false, open: true, receipt: "rc-m1" },
    { ref: { at: "lifeos", table: "outbox", id: "m2" }, do: "send", item: item("m2"), changed: false, open: true, receipt: "rc-m2" },
    // rewritten after the thread asked: unticked until he opens it
    { ref: { at: "lifeos", table: "outbox", id: "m3" }, do: "send", item: item("m3"), changed: true, open: true },
  ],
  ...over,
});

const block = (detail: unknown, status = "completed"): Block =>
  ({ id: "b1", role: "tool", tool: { name: "mcp__app__outbox_request", status, detail: typeof detail === "string" ? detail : JSON.stringify(detail) } }) as unknown as Block;
const asked = block({ outboxRequest: { id: "r1", host: "box" }, message: "Asked: request 3 lists 3 items." });

beforeEach(() => {
  world.calls = [];
  world.request = request();
  world.answer = null;
  world.hold = null;
  world.waiting = [];
  workSwitch.reset();
  setWorkOn("box", true);
  resetOutboxStore();
});
afterEach(cleanup);

async function drawn() {
  render(<OutboxRequestRow block={asked} />);
  await waitFor(() => expect(document.querySelector("[data-outbox-request]")).toBeTruthy());
  return document.querySelector("[data-outbox-request]") as HTMLElement;
}
const card = () => document.querySelector("[data-outbox-request]") as HTMLElement;
const sendButton = () => within(card()).getAllByRole("button").find((b) => /^(Send|Approve|Discard) \d/.test(b.textContent ?? "")) as HTMLButtonElement;

describe("the request card", () => {
  it("waits: his words quoted, the rows he may press ticked, a changed one unticked with its word, and Send N", async () => {
    const el = await drawn();
    expect(el.textContent).toContain("You asked: “send the roster mails, all three”");
    // The request's one name, as its row and notice say it; the press counts what is ticked.
    expect(el.querySelector("h3")!.textContent).toBe("Send 3 mails to 3 people");
    const rows = [...el.querySelectorAll("[data-summary-row]")];
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    expect(rows[2]!.textContent).toContain("Changed since asked");
    // An empty tick he cannot take until he opens the row, never a blank slot.
    const waiting = within(rows[2] as HTMLElement).getByRole("checkbox");
    expect(waiting.getAttribute("aria-checked")).toBe("false");
    expect(waiting.hasAttribute("disabled") || waiting.getAttribute("aria-disabled") === "true" || waiting.hasAttribute("data-disabled")).toBe(true);
    expect(within(rows[2] as HTMLElement).getByRole("button", { name: /^Review the change / })).toBeTruthy();
    expect(sendButton().textContent).toBe("Send 2");
    expect(within(el).getByRole("button", { name: "Not now" })).toBeTruthy();
    // the card's shape: the transcript's one card, a hairline on the card fill
    expect(el.className).toContain("rounded-xl");
    expect(el.className).toContain("p-4");
    expect(el.className).toContain("bg-card");
  });

  it("opening a changed row asks its host for a fresh receipt, and he ticks it himself", async () => {
    const el = await drawn();
    const changed = el.querySelectorAll("[data-summary-row]")[2] as HTMLElement;
    await act(async () => fireEvent.click(within(changed).getByRole("button", { name: /^(Open|Review the change) / })));
    expect(world.calls.filter((c) => c.method === "work.outbox.request.view").map((c) => c.params)).toEqual([{ id: "r1", ref: { at: "lifeos", table: "outbox", id: "m3" } }]);
    const tick = await waitFor(() => {
      const box = within(el.querySelectorAll("[data-summary-row]")[2] as HTMLElement).getByRole("checkbox");
      expect(box.hasAttribute("data-disabled")).toBe(false);
      return box;
    });
    expect(tick.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(tick);
    expect(sendButton().textContent).toBe("Send 3");
  });

  it("sends only the ticked rows' receipts; each row shows the working mark while it goes", async () => {
    let let_go!: () => void;
    world.hold = new Promise<void>((r) => (let_go = r));
    world.answer = (r, receipts) => ({ ...r, state: "answered", answeredBy: "owner", answeredAt: Date.now(), rows: r.rows.map((row) => (receipts.includes(row.receipt ?? "") ? { ...row, open: false, result: { ok: true, state: "sent" } } : row)) });
    const el = await drawn();
    // He unticks one: the press never widens past what he left ticked.
    fireEvent.click(within(el.querySelectorAll("[data-summary-row]")[1] as HTMLElement).getByRole("checkbox"));
    expect(sendButton().textContent).toBe("Send 1");
    fireEvent.click(sendButton());
    await waitFor(() => expect(el.querySelectorAll('[data-summary-row] [data-state="working"]')).toHaveLength(1));
    await act(async () => let_go());
    expect(world.calls.filter((c) => c.method === "work.outbox.decide").map((c) => c.params)).toEqual([{ request: "r1", receipts: ["rc-m1"] }]);
  });

  it("done with a failure: each row's result, the sum, who pressed and when, and Send again for what did not go", async () => {
    world.waiting = [item("m2", { state: "failed" })];
    world.answer = (r) => ({
      ...r,
      state: "answered",
      answeredBy: "owner",
      answeredAt: new Date(2026, 10, 24, 9, 41).getTime(),
      rows: [
        { ...r.rows[0]!, open: false, item: { ...r.rows[0]!.item!, state: "sent", lifeos: "queued", decidedAt: Date.now() }, result: { ok: true, state: "sent" } },
        { ...r.rows[1]!, result: { ok: false, error: "Outlook did not answer in time" } },
        r.rows[2]!,
      ],
    });
    const el = await drawn();
    await act(async () => fireEvent.click(sendButton()));
    // Queued is queued, never sent: the sum says it as its rows do.
    await waitFor(() => expect(el.querySelector("h3")!.textContent).toBe("Queued 1 in LifeOS, 1 not sent"));
    const rows = [...el.querySelectorAll("[data-summary-row]")];
    expect(rows[0]!.textContent).toContain("Queued in LifeOS");
    expect(rows[1]!.querySelector("[data-summary-side]")!.textContent).toBe("Outlook did not answer in time");
    expect(rows[2]!.textContent).toContain("Left out");
    expect(el.querySelector("[data-outbox-request-by]")!.textContent).toBe("by you at 9:41 AM");
    expect(within(el).queryByRole("button", { name: "Not now" })).toBeNull();
    await act(async () => fireEvent.click(within(el).getByRole("button", { name: "Send again" })));
    const again = world.calls.filter((c) => c.method === "work.outbox.decide" && c.params.items);
    // The request's many-ness and the revision the card drew go with it (review finding 10).
    expect(again.map((c) => c.params)).toEqual([{ items: [{ ref: { at: "lifeos", table: "outbox", id: "m2" }, do: "send", rev: 500 }], many: true, via: "outbox" }]);
  });

  it("Not now collapses the card to one muted line", async () => {
    const el = await drawn();
    await act(async () => fireEvent.click(within(el).getByRole("button", { name: "Not now" })));
    await waitFor(() => expect(document.querySelector("[data-outbox-request]")).toBeNull());
    const line = document.querySelector("[data-outbox-request-line]")!;
    expect(line.textContent).toContain("Not now");
    expect(world.calls.filter((c) => c.method === "work.outbox.decline").map((c) => c.params)).toEqual([{ request: "r1" }]);
  });

  it("a request that ran out is one muted line, with no press", async () => {
    world.request = request({ state: "void", why: "Its day ran out." });
    render(<OutboxRequestRow block={asked} />);
    await waitFor(() => expect(document.querySelector("[data-outbox-request-line]")?.textContent).toContain("No longer open"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a refused ask is one muted line with the first sentence of why", () => {
    const refused = block([{ type: "text", text: "Refused: none of the owner's recent messages in this thread tells you to do this. Do not ask again until he writes it." }], "failed");
    render(<OutboxRequestRow block={refused} />);
    const line = document.querySelector("[data-outbox-request-line]")!;
    expect(line.textContent).toContain("Not asked");
    expect(line.textContent).toContain("none of the owner's recent messages in this thread tells you to do this.");
    expect(line.textContent).not.toContain("Do not ask again");
  });

  it("never wears the warning colour: held is not Needs you", async () => {
    const el = await drawn();
    expect(el.outerHTML).not.toMatch(/warning|amber/);
    expect(el.querySelector('[data-state="waiting"]')).toBeNull();
    for (const file of ["RequestCard.tsx", "requests.ts"]) {
      const source = readFileSync(resolve(__dirname, file), "utf8");
      expect(source).not.toMatch(/\b(text|bg|border|ring|fill|stroke)-warning\b|state="waiting"|amber/);
    }
  });
});

describe("the card's words", () => {
  it("reads the request from every envelope the harness keeps, and a refusal from a failed call", () => {
    expect(requestOfBlock(asked)).toEqual({ id: "r1", host: "box" });
    expect(requestOfBlock(block({ structuredContent: { outboxRequest: { id: "r2", host: "mac" } } }))).toEqual({ id: "r2", host: "mac" });
    expect(requestOfBlock(block([{ type: "text", text: JSON.stringify({ outboxRequest: { id: "r3", host: "box" }, message: "Asked" }) }]))).toEqual({ id: "r3", host: "box" });
    expect(requestOfBlock(block("Refused: His words do not name item 52. Ask only for what he named.", "failed"))).toEqual({ refused: "His words do not name item 52." });
  });

  it("names the press by what the ticked rows do", () => {
    expect(pressLabel(["send", "send"])).toBe("Send 2");
    expect(pressLabel(["send", "later"])).toBe("Send 2");
    expect(pressLabel(["discard"])).toBe("Discard 1");
    expect(pressLabel(["send", "discard", "send"])).toBe("Approve 3");
    expect(refusalWords("Refused: Item 31 is another job's; a thread asks only about its own job.")).toBe("Item 31 is another job's; a thread asks only about its own job.");
  });
});

describe("ticks bound to receipts (review finding 9, and the Outbox's copy drawn first)", () => {
  const tickOf = (i: number) => within(card().querySelectorAll("[data-summary-row]")[i] as HTMLElement).queryByRole("checkbox");

  it("a request first drawn without receipts ticks its unchanged rows once the receipts arrive", async () => {
    const bare = request({ rows: request().rows.map(({ receipt: _r, ...row }) => row) });
    world.request = bare;
    render(<OutboxRequestRow block={asked} />);
    await waitFor(() => expect(card()).toBeTruthy());
    expect(tickOf(0)).toBeNull();
    world.request = request();
    await act(async () => void (await getRequest("box", "r1")));
    await waitFor(() => expect(tickOf(0)?.getAttribute("aria-checked")).toBe("true"));
    expect(tickOf(1)?.getAttribute("aria-checked")).toBe("true");
    // the row changed since the ask still waits for his own tick: an empty one he cannot take yet
    expect(tickOf(2)?.getAttribute("aria-checked")).toBe("false");
    expect(tickOf(2)?.hasAttribute("data-disabled")).toBe(true);
    expect(sendButton().textContent).toBe("Send 2");
  });

  it("a refresh that marks a ticked row changed clears its tick, and the fresh receipt after he opens it starts unticked", async () => {
    await drawn();
    expect(tickOf(1)?.getAttribute("aria-checked")).toBe("true");
    world.request = request({ rows: request().rows.map((r, i) => (i === 1 ? { ...r, changed: true, receipt: undefined } : r)) });
    await act(async () => void (await getRequest("box", "r1")));
    await waitFor(() => expect(tickOf(1)?.hasAttribute("data-disabled")).toBe(true));
    expect(tickOf(1)!.getAttribute("aria-checked")).toBe("false");
    expect(sendButton().textContent).toBe("Send 1");
    await act(async () => fireEvent.click(within(card().querySelectorAll("[data-summary-row]")[1] as HTMLElement).getByRole("button", { name: /^(Open|Review the change) / })));
    await waitFor(() => expect(tickOf(1)?.hasAttribute("data-disabled")).toBe(false));
    expect(tickOf(1)!.getAttribute("aria-checked")).toBe("false");
    expect(sendButton().textContent).toBe("Send 1");
  });

  it("a row whose receipt changes on a refresh is no longer ticked", async () => {
    await drawn();
    world.request = request({ rows: request().rows.map((r, i) => (i === 0 ? { ...r, receipt: "rc-m1-moved" } : r)) });
    await act(async () => void (await getRequest("box", "r1")));
    await waitFor(() => expect(tickOf(0)?.getAttribute("aria-checked")).toBe("false"));
    expect(world.calls.filter((c) => c.method === "work.outbox.decide")).toEqual([]);
  });
});

describe("Send again on an answered request (review finding 10)", () => {
  const answered = (rows: OutboxRequest["rows"]) => () => ({ ...world.request, state: "answered" as const, answeredBy: "owner", answeredAt: Date.now(), rows });

  it("a failed Later row takes a new time he picks, said before it goes, as many with the revision drawn", async () => {
    world.request = request({ rows: [{ ...request().rows[0]!, do: "later", at: Date.now() + 3_600_000 }] });
    world.waiting = [item("m1", { state: "held" })];
    world.answer = answered([{ ...request().rows[0]!, do: "later", at: Date.now() + 3_600_000, result: { ok: false, error: "LifeOS refused the time" } }]);
    const el = await drawn();
    await act(async () => fireEvent.click(sendButton()));
    await waitFor(() => expect(within(el).getByRole("button", { name: "Pick a new time…" })).toBeTruthy());
    expect(within(el).queryByRole("button", { name: "Send again" })).toBeNull();
    fireEvent.click(within(el).getByRole("button", { name: "Pick a new time…" }));
    const dialog = await screen.findByRole("dialog");
    // The time it will go is said before he presses.
    await waitFor(() => expect(dialog.textContent).toMatch(/\d:\d\d [AP]M/));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Send later" })));
    const later = world.calls.filter((c) => c.method === "work.outbox.decide" && c.params.items);
    expect(later).toHaveLength(1);
    expect(later[0]!.params).toMatchObject({ many: true, via: "outbox", items: [{ ref: { id: "m1" }, do: "later", rev: 500 }] });
    expect((later[0]!.params.items as { at?: number }[])[0]!.at).toBeGreaterThan(Date.now());
  });

  it("a failed row whose item moved since, or may have gone, is opened in the Outbox, never retried from the card", async () => {
    world.waiting = [item("m2", { state: "failed", updatedAt: 900 })];
    world.answer = answered([{ ...request().rows[1]!, result: { ok: false, error: "Changed, open it again" } }]);
    const el = await drawn();
    await act(async () => fireEvent.click(sendButton()));
    await waitFor(() => expect(within(el).getByRole("button", { name: "Open in the Outbox" })).toBeTruthy());
    expect(within(el).queryByRole("button", { name: /Send .*again|Send again/ })).toBeNull();
    fireEvent.click(within(el).getByRole("button", { name: "Open in the Outbox" }));
    expect(wantedOutbox()).toBe("box:lifeos:m2");
    expect(world.calls.filter((c) => c.method === "work.outbox.decide" && c.params.items)).toEqual([]);
    wantOutbox(null);
  });

  it("a send that may have gone goes to its detail too", async () => {
    world.waiting = [item("m2", { state: "failed", outcomeUnknown: true })];
    world.answer = answered([{ ...request().rows[1]!, item: item("m2", { state: "failed", outcomeUnknown: true }), result: { ok: false, error: "Outlook did not answer in time" } }]);
    const el = await drawn();
    await act(async () => fireEvent.click(sendButton()));
    await waitFor(() => expect(within(el).getByRole("button", { name: "Open in the Outbox" })).toBeTruthy());
    expect(within(el).queryByRole("button", { name: "Send again" })).toBeNull();
  });
});

describe("Send again binds the revision the press attempted (review round 3, finding 4)", () => {
  const answered = (rows: OutboxRequest["rows"]) => () => ({ ...world.request, state: "answered" as const, answeredBy: "owner", answeredAt: Date.now(), rows });

  it("a row refused because its item moved after the receipt opens in the Outbox, though the copies of the new item agree", async () => {
    // He pressed at revision 500; the item became 900 before its claim, and the host answered with the new item.
    world.waiting = [item("m2", { state: "held", updatedAt: 900 })];
    world.answer = answered([{ ...request().rows[1]!, item: item("m2", { updatedAt: 900 }), result: { ok: false, error: "Changed, open it again" } }]);
    const el = await drawn();
    await act(async () => fireEvent.click(sendButton()));
    await waitFor(() => expect(within(el).getByRole("button", { name: "Open in the Outbox" })).toBeTruthy());
    expect(within(el).queryByRole("button", { name: "Send again" })).toBeNull();
  });

  it("a request answered elsewhere, whose press this card did not make, sends a failed row to its detail", async () => {
    world.request = request({ state: "answered", answeredBy: "owner:remote", answeredAt: Date.now(), rows: [{ ...request().rows[0]!, result: { ok: false, error: "Outlook did not answer in time" } }] });
    world.waiting = [item("m1", { state: "failed" })];
    render(<OutboxRequestRow block={asked} />);
    await waitFor(() => expect(within(card()).getByRole("button", { name: "Open in the Outbox" })).toBeTruthy());
    expect(within(card()).queryByRole("button", { name: "Send again" })).toBeNull();
  });

  it("a row whose item still stands at the attempted revision is sent again with that revision", async () => {
    world.waiting = [item("m2", { state: "failed" })];
    world.answer = answered([{ ...request().rows[1]!, result: { ok: false, error: "Outlook did not answer in time" } }]);
    const el = await drawn();
    await act(async () => fireEvent.click(sendButton()));
    await act(async () => fireEvent.click(await within(el).findByRole("button", { name: "Send again" })));
    expect(world.calls.filter((c) => c.method === "work.outbox.decide" && c.params.items).map((c) => c.params)).toEqual([
      { items: [{ ref: { at: "lifeos", table: "outbox", id: "m2" }, do: "send", rev: 500 }], many: true, via: "outbox" },
    ]);
  });
});

describe("council round 1: the card's words", () => {
  it("names a request once, by kind, as its row and notice say it", async () => {
    const { requestName } = await import("./requests");
    expect(requestName(request())).toBe("Send 3 mails to 3 people");
    expect(requestName({ head: "Send 2 items", rows: [] })).toBe("Send 2 items");
  });

  it("leads a row that dies with Discard, its act muted, so a mixed card never reads a discard as a send", async () => {
    world.request = request({ rows: [request().rows[0]!, { ...request().rows[1]!, do: "discard" }] });
    const el = await drawn();
    const act = el.querySelectorAll("[data-summary-row]")[1]!.querySelector("[data-summary-act]")!;
    expect(act.textContent).toBe("Discard Send to Jordan Patel");
    expect(act.querySelector(".text-muted-foreground")!.textContent).toBe("Send to Jordan Patel");
    // The action is said once, where the row starts: no second "Discard" at its end.
    expect(el.querySelectorAll("[data-summary-row]")[1]!.querySelector("[data-summary-side]")).toBeNull();
    expect(el.querySelector("h3")!.textContent).toBe("Send 1 mail to 1 person and discard 1 mail");
    expect(sendButton().textContent).toBe("Approve 2");
  });
});
