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
          return { items: [], waiting: 0 };
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
import { resetRequests } from "./requests";
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
  resetRequests();
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
    expect(el.querySelector("h3")!.textContent).toBe("Send 2 mails to 2 people");
    const rows = [...el.querySelectorAll("[data-summary-row]")];
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    expect(rows[2]!.textContent).toContain("Changed since asked");
    expect(within(rows[2] as HTMLElement).queryByRole("checkbox")).toBeNull();
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
    await act(async () => fireEvent.click(within(changed).getByRole("button", { name: /^Open / })));
    expect(world.calls.filter((c) => c.method === "work.outbox.request.view").map((c) => c.params)).toEqual([{ id: "r1", ref: { at: "lifeos", table: "outbox", id: "m3" } }]);
    const tick = await waitFor(() => within(el.querySelectorAll("[data-summary-row]")[2] as HTMLElement).getByRole("checkbox"));
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
    await waitFor(() => expect(el.querySelector("h3")!.textContent).toBe("Sent 1, 1 not sent"));
    const rows = [...el.querySelectorAll("[data-summary-row]")];
    expect(rows[0]!.textContent).toContain("Queued in LifeOS");
    expect(rows[1]!.querySelector("[data-summary-side]")!.textContent).toBe("Outlook did not answer in time");
    expect(rows[2]!.textContent).toContain("Left out");
    expect(el.querySelector("[data-outbox-request-by]")!.textContent).toBe("by you at 9:41 AM");
    expect(within(el).queryByRole("button", { name: "Not now" })).toBeNull();
    await act(async () => fireEvent.click(within(el).getByRole("button", { name: "Send again" })));
    const again = world.calls.filter((c) => c.method === "work.outbox.decide" && c.params.items);
    expect(again.map((c) => c.params)).toEqual([{ items: [{ ref: { at: "lifeos", table: "outbox", id: "m2" }, do: "send", rev: 500 }], via: "outbox" }]);
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
