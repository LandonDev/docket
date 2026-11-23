// @vitest-environment jsdom
/**
 * After the council's fifth round: Amount widens only for a row both ways;
 * Entry…, Trip… and Mileage rate… wait for a read; a skipped event's answer
 * says nothing; an event picked in Add → Trip… reopens a skipped one, an
 * offer's dialog does not; a hand-typed trip filed with other values says
 * so; the offers' Add ends on the edge; loading draws its fixed words as
 * text; the read-only dialog lands focus on Open ledger.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarOffer, MoneyRead, ToConfirm } from "@shared/contract-work-money";
import type { Period } from "@shared/work/money";

const host: { asked: { method: string; params: Record<string, unknown> }[]; read: (p: Period) => MoneyRead | Promise<MoneyRead>; answer: (method: string, params: Record<string, unknown>) => unknown } = {
  asked: [],
  read: () => {
    throw new Error("unset");
  },
  answer: () => null,
};
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    primary: () => ({ environmentId: "mac" }),
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ method, params });
        if (method === "work.money.read") return host.read({ from: params.from as string, to: params.to as string });
        return host.answer(method, params);
      },
    }),
  },
}));
const toast = Object.assign(vi.fn(), { error: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() });
vi.mock("../../components/ui/toaster", async (original) => ({ ...(await original<object>()), loadToast: async () => toast }));

const { Head, View, setMoneyPeriod } = await import("./MoneyView");
const { SUGGESTED_WORDS } = await import("./api");
const { ALL_ROWS, BOTH_WAYS, readOf } = await import("./money.fixtures");
const { openMoneyDialog } = await import("./MoneyView");
const { filedWords, SKIPPED_WORDS } = await import("./TripDialog");

const props = { env: "box", workspace: { id: "ws", environmentId: "box", name: "Refereeing", kind: "work", sector: "ref" }, sector: "ref", lifeos: {}, startThread: () => {} } as never;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const asked = (method: string) => host.asked.filter((a) => a.method === method).map((a) => a.params);
const waiting = (id: string, over: Partial<ToConfirm> = {}): ToConfirm => ({ id, state: "ready", source: "drop", name: `${id}.jpg`, picture: false, fields: { amount: 4210, date: "2026-11-20", who: `Shop ${id}`, category: null }, at: 1, ...over });
const offer = (eventId: string, over: Partial<CalendarOffer> = {}): CalendarOffer => ({ eventId, date: "2026-11-21", title: `Game ${eventId}`, place: "Harrison HS", fee: 7500, miles: 24, measured: true, ...over });

function mount() {
  return render(
    <>
      <div data-testid="head">
        <Head {...props} />
      </div>
      <View {...props} />
    </>,
  );
}

beforeEach(() => {
  host.asked.length = 0;
  host.read = (p) => readOf(p);
  host.answer = (method) => (method === "work.money.entry" || method === "work.money.paid" || method === "work.money.accept" ? { ok: true, ref: "r", row: 2 } : method === "work.money.state" ? { host: "box", jobs: [] } : null);
  toast.mockClear();
  toast.error.mockClear();
  toast.loading.mockClear();
  toast.dismiss.mockClear();
  setMoneyPeriod({ span: "month", year: 2026, month: 11 });
  URL.createObjectURL ??= () => "blob:x";
  URL.revokeObjectURL ??= () => {};
});
afterEach(cleanup);


const amountHead = (root: ParentNode) => Array.from(root.querySelectorAll("th")).find((th) => th.textContent === "Amount")!.className;
const off = (item: HTMLElement) => item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled");

describe("Entries' Amount column", () => {
  it("widens only while a shown row has money both ways, and the bones keep the usual width", async () => {
    let land: (r: MoneyRead) => void = () => {};
    host.read = () => new Promise<MoneyRead>((r) => (land = r));
    mount();
    await settle();
    expect(amountHead(screen.getByLabelText("Loading money"))).toContain("w-28");
    await act(async () => land(readOf({ from: "2026-11-01", to: "2026-12-01" })));
    await settle();
    expect(amountHead(screen.getByRole("region", { name: "Entries" }))).toContain("w-44");
    cleanup();
    host.read = (p) => readOf(p, ALL_ROWS.filter((r) => r !== BOTH_WAYS));
    mount();
    await settle();
    expect(amountHead(screen.getByRole("region", { name: "Entries" }))).toContain("w-28");
  });
});

describe("the header's menus before a read has landed", () => {
  it("keep Entry…, Trip… and Mileage rate… off while loading or after a failed first read, Receipt… on, and let them on once a read lands", async () => {
    let fail = true;
    host.read = (p) => (fail ? Promise.reject(new Error("The box did not answer")) : readOf(p));
    mount();
    await settle();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    const head = within(screen.getByTestId("head"));
    fireEvent.click(head.getByRole("button", { name: "Add" }));
    expect(off(await screen.findByRole("menuitem", { name: "Entry…" }))).toBe(true);
    expect(off(screen.getByRole("menuitem", { name: "Trip…" }))).toBe(true);
    expect(off(screen.getByRole("menuitem", { name: "Receipt…" }))).toBe(false);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await settle();
    fireEvent.click(head.getByRole("button", { name: "More" }));
    expect(off(await screen.findByRole("menuitem", { name: "Mileage rate…" }))).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await settle();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    await settle();
    fireEvent.click(head.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(off(screen.getByRole("menuitem", { name: "Entry…" }))).toBe(false));
    expect(off(screen.getByRole("menuitem", { name: "Trip…" }))).toBe(false);
  });
});

describe("an event skipped meanwhile", () => {
  it("says nothing for a skipped answer from Add all, and still says the others' suggestion once", async () => {
    host.read = (p) => readOf(p, undefined, { calendar: [offer("e1"), offer("e2")] });
    host.answer = (method, params) => {
      if (method !== "work.money.trip") return null;
      return params.eventId === "e1" ? { skipped: true, pay: null, trip: null } : { pay: { ok: true, ref: "r", row: 50, suggested: true }, trip: null };
    };
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add all" }));
    await settle();
    await settle();
    expect(toast.mock.calls.map((c) => c[0])).toEqual([SUGGESTED_WORDS]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps an offer's dialog open saying it was skipped, and never asks to reopen it", async () => {
    host.answer = (method) => (method === "work.money.trip" ? { skipped: true, pay: null, trip: null } : null);
    mount();
    await settle();
    act(() => openMoneyDialog({ kind: "trip", offer: offer("e1") }));
    const dialog = await screen.findByRole("dialog", { name: "Trip" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await settle();
    expect(asked("work.money.trip")[0]).not.toHaveProperty("reopen");
    expect(within(dialog).getByText(SKIPPED_WORDS)).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("a hand-typed trip pressed again", () => {
  const typeTrip = async (answer: Record<string, unknown>) => {
    let first = true;
    host.answer = (method) => {
      if (method === "work.money.events") return { events: [] };
      if (method !== "work.money.trip") return null;
      if (first) {
        first = false;
        throw new Error("The box did not answer");
      }
      return answer;
    };
    mount();
    await settle();
    fireEvent.click(within(screen.getByTestId("head")).getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Trip…" }));
    const dialog = await screen.findByRole("dialog", { name: "Trip" });
    await settle();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Clinic" } });
    fireEvent.change(within(dialog).getByLabelText("Miles there and back"), { target: { value: "12" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await settle();
    fireEvent.change(within(dialog).getByLabelText("Fee"), { target: { value: "40" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await settle();
    return dialog;
  };

  it("names what the first Add filed when the form has changed since, and stays open", async () => {
    const dialog = await typeTrip({ already: true, filed: { miles: 12, fee: null }, pay: null, trip: null });
    expect(within(dialog).getByText("This trip was already added with 12 mi. Change it in the ledger or the mileage log.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Trip" })).toBe(dialog);
  });

  it("is saved when what was filed is what the form holds", async () => {
    await typeTrip({ already: true, filed: { miles: 12, fee: 4000 }, pay: null, trip: null });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Trip" })).toBeNull());
  });

  it("says each part filed, leaving out what is none", () => {
    expect(filedWords({ miles: 24, fee: 8000 })).toBe("This trip was already added with 24 mi and $80.00 pay. Change it in the ledger or the mileage log.");
    expect(filedWords({ miles: null, fee: 8000 })).toBe("This trip was already added with $80.00 pay. Change it in the ledger or the mileage log.");
  });
});

describe("the offers' Add", () => {
  it("ends on Review's edge, the spinner opening to its left", async () => {
    host.read = (p) => readOf(p, undefined, { calendar: [offer("e1")] });
    mount();
    await settle();
    const add = screen.getByRole("button", { name: "Add Game e1" });
    expect((add.querySelector("[data-slot=busy-label] > span") as HTMLElement).className).toContain("justify-end");
  });
});

describe("loading", () => {
  it("draws the words that never change as text and bones only what the read fills", async () => {
    host.read = () => new Promise<MoneyRead>(() => {});
    mount();
    await settle();
    const bones = within(screen.getByLabelText("Loading money"));
    expect(bones.getByRole("heading", { name: "Entries" })).toBeTruthy();
    for (const label of ["In", "Out", "Net"]) expect(bones.getByText(label)).toBeTruthy();
  });
});

describe("the read-only dialog", () => {
  it("lands focus on Open ledger, never on a stored value", async () => {
    mount();
    await settle();
    const row = document.querySelector(`[data-money-row="${BOTH_WAYS.row}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /\+\$30\.00 and \$20\.00/ }));
    const dialog = await screen.findByRole("dialog", { name: "Entry" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Open ledger" })));
  });
});
