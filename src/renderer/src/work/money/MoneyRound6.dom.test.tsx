// @vitest-environment jsdom
/**
 * Before the council's fourth round: Create sends its key with the page and,
 * when its number is taken, takes the next free one; a hand-typed trip sends
 * one key for the dialog's life; a mileage log that cannot be read says so in
 * the miles line's place; a row below zero reads in its own words and opens
 * read only; a renamed Status column is named with Open ledger.
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
const { BOTH_WAYS, REFUND } = await import("./money.fixtures");
const { EMPTY_READ, readOf } = await import("./money.fixtures");

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


const paste = (target: EventTarget, files: File[]) => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files } });
  target.dispatchEvent(event);
};


describe("an invoice's number", () => {
  it("is taken with Create's key, and a taken number is replaced by the next free one with the host's sentence kept", async () => {
    let taken = true;
    host.answer = (method) => {
      if (method === "work.money.invoiceNext") return { number: taken ? "1001" : "1002", from: { name: "Ridgeline Officiating", address: "", pay: "" }, dueDays: 14 };
      if (method === "work.money.invoice") {
        if (taken) {
          taken = false;
          throw new Error("Invoice 1001 is taken. The next free number is 1002.");
        }
        return { name: "Invoice 1002 Harlan.pdf", html: "<p/>" };
      }
      if (method === "work.formats.print") return { name: "x", data: btoa("pdf"), warnings: [] };
      if (method === "work.money.keep") return { source: { at: "file", host: "box", path: "/m/Invoices/Invoice 1002 Harlan.pdf" }, receipt: "Invoices/Invoice 1002 Harlan.pdf", acted: { ok: true, ref: "r", row: 40 } };
      return null;
    };
    mount();
    await settle();
    fireEvent.click(within(screen.getByTestId("head")).getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Invoice…" }));
    const dialog = await screen.findByRole("dialog", { name: "Invoice" });
    await settle();
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "Harlan Valley Officials" } });
    fireEvent.change(within(dialog).getByLabelText("What, line 1"), { target: { value: "Varsity games" } });
    fireEvent.change(within(dialog).getByLabelText("Rate, line 1"), { target: { value: "75" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    for (let i = 0; i < 3; i++) await settle();
    expect(within(dialog).getByText("Invoice 1001 is taken. The next free number is 1002.")).toBeTruthy();
    expect((within(dialog).getByLabelText("Number") as HTMLInputElement).value).toBe("1002");
    // Nothing is printed for a refused number.
    expect(asked("work.formats.print")).toEqual([]);
    expect(String(asked("work.money.invoice")[0].key).length).toBeGreaterThanOrEqual(8);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    for (let i = 0; i < 3; i++) await settle();
    const page = asked("work.money.invoice").at(-1)!;
    expect(page.invoice).toMatchObject({ number: "1002" });
    expect(asked("work.money.keep").at(-1)!.key).toBe(page.key);
  });
});

describe("a hand-typed trip", () => {
  it("sends one key for the dialog's life, the same on every Add", async () => {
    let fail = true;
    host.answer = (method) => {
      if (method === "work.money.events") return { events: [] };
      if (method === "work.money.trip") {
        if (fail) {
          fail = false;
          throw new Error("The box did not answer");
        }
        return { pay: null, trip: { row: 3, ref: "m", value: 1680 } };
      }
      return null;
    };
    mount();
    await settle();
    fireEvent.click(within(screen.getByTestId("head")).getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Trip…" }));
    const dialog = await screen.findByRole("dialog", { name: "Trip" });
    await settle();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Clinic at Oak Ridge" } });
    fireEvent.change(within(dialog).getByLabelText("Miles there and back"), { target: { value: "18" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await settle();
    const keys = asked("work.money.trip").map((t) => t.key);
    expect(keys).toHaveLength(2);
    expect(String(keys[0]).length).toBeGreaterThanOrEqual(8);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe("a mileage log that cannot be read", () => {
  it("says so in the miles line's place, with Open mileage log for missing columns, and the ledger still reads", async () => {
    host.read = (p) => readOf(p, undefined, { problems: [{ kind: "mileage", reason: "columns", missing: ["Date", "Miles"] }], miles: { miles: 0, value: 0, rate: null } });
    mount();
    await settle();
    const line = document.querySelector("[data-mileage-problem]") as HTMLElement;
    expect(line.textContent).toContain("The mileage log has no Date or Miles column, so its trips are not counted.");
    expect(document.querySelector("[data-money-figures]")).toBeTruthy();
    fireEvent.click(within(line).getByRole("button", { name: "Open mileage log" }));
    await waitFor(() => expect(asked("work.money.open")).toHaveLength(1));
    cleanup();
    host.read = (p) => readOf(p, undefined, { problems: [{ kind: "mileage", reason: "outside", missing: [] }], miles: { miles: 0, value: 0, rate: null } });
    mount();
    await settle();
    const outside = document.querySelector("[data-mileage-problem]") as HTMLElement;
    expect(outside.textContent).toBe("The mileage log leads outside this job's folder, so its trips are not counted.");
    expect(within(outside).queryByRole("button")).toBeNull();
  });
});

describe("a row below zero", () => {
  it("reads in its own words and opens read only for the ledger", async () => {
    mount();
    await settle();
    const row = document.querySelector(`[data-money-row="${REFUND.row}"]`) as HTMLElement;
    expect(row.querySelectorAll("td")[3].textContent).toBe("-$20.00 out");
    fireEvent.click(within(row).getByRole("button", { name: /-\$20\.00 out/ }));
    const dialog = await screen.findByRole("dialog", { name: "Entry" });
    expect(within(dialog).getByText("This row has an amount below zero. Edit it in the ledger.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
    expect((within(dialog).getByLabelText("Amount") as HTMLInputElement).value).toBe("-$20.00 out");
  });

  it("draws no bar below the year chart's axis", async () => {
    const { byMonthBars } = await import("./MoneyView");
    expect(byMonthBars([{ month: 11, in: 3000, out: -2000 }])).toEqual([{ month: "Nov", in: 3000, out: 0 }]);
  });
});

describe("a renamed Status column", () => {
  it("is named with Open ledger and no Restore", async () => {
    host.read = (p) => readOf(p, [], { problems: [{ kind: "columns", missing: ["Status"], renamed: ["State"] }] });
    mount();
    await settle();
    expect(screen.getByText("No Status column. State may be it: name it back in the ledger.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore columns" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open ledger" })).toBeTruthy();
  });
});
