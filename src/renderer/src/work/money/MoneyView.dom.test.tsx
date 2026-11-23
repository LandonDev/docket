// @vitest-environment jsdom
/**
 * The Money view on screen: the period and its stepper drive the read, Year
 * draws the chart and Month does not, a category narrows the entries and
 * Clear brings them back, a row opens the entry dialog (Return saves, Escape
 * closes, Save waits for an amount and a date), a write the ledger outran
 * says so and reads again, Paid names its row, the empty ledger's action
 * opens the dialog, and the columns problem restores the headers.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoneyRead } from "@shared/contract-work-money";
import { sigOf, type Period } from "@shared/work/money";

const host: { asked: { method: string; params: Record<string, unknown> }[]; read: (p: Period) => MoneyRead; answer: (method: string, params: Record<string, unknown>) => unknown } = {
  asked: [],
  read: () => {
    throw new Error("unset");
  },
  answer: () => null,
};
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
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
const { CHANGED_WORDS } = await import("./api");
const { ALL_ROWS, EMPTY_READ, NOVEMBER, readOf } = await import("./money.fixtures");

const props = { env: "box", workspace: { id: "ws", environmentId: "box", name: "Refereeing", kind: "work", sector: "ref" }, sector: "ref", lifeos: {}, startThread: () => {} } as never;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const asked = (method: string) => host.asked.filter((a) => a.method === method).map((a) => a.params);

function mount() {
  return render(
    <>
      <div role="toolbar" aria-label="Money header">
        <Head {...props} />
      </div>
      <View {...props} />
    </>,
  );
}

beforeEach(() => {
  host.asked.length = 0;
  host.read = (p) => readOf(p);
  host.answer = (method) => (method === "work.money.entry" || method === "work.money.paid" ? { ok: true, ref: "r", row: 2 } : null);
  toast.mockClear();
  toast.error.mockClear();
  setMoneyPeriod({ span: "month", year: 2026, month: 11 });
});
afterEach(cleanup);

describe("the Money view", () => {
  it("reads the period the stepper stands on, and draws a chart for a year alone", async () => {
    mount();
    await settle();
    expect(asked("work.money.read").at(-1)).toEqual({ workspaceId: "ws", from: "2026-11-01", to: "2026-12-01" });
    expect(screen.getByText("November 2026")).toBeTruthy();
    expect(document.querySelector("[data-chart]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await settle();
    expect(screen.getByText("October 2026")).toBeTruthy();
    expect(asked("work.money.read").at(-1)).toEqual({ workspaceId: "ws", from: "2026-10-01", to: "2026-11-01" });
    fireEvent.click(screen.getByRole("button", { name: "Year" }));
    await settle();
    expect(asked("work.money.read").at(-1)).toEqual({ workspaceId: "ws", from: "2026-01-01", to: "2027-01-01" });
    expect(screen.getByRole("region", { name: "In and out by month" }).querySelector("[data-chart]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next year" }));
    await settle();
    expect(asked("work.money.read").at(-1)).toMatchObject({ from: "2027-01-01", to: "2028-01-01" });
  });

  it("shows the figures as text on one row, and Owed apart only when something is", async () => {
    mount();
    await settle();
    const figures = document.querySelector("[data-money-figures]")!;
    expect(figures.textContent).toContain("In");
    expect(figures.textContent).toContain("Owed to you");
    expect(figures.textContent).toContain("You owe");
    host.read = (p) => readOf(p, ALL_ROWS.map((r) => ({ ...r, status: "Paid" as const })));
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(document.querySelector("[data-money-figures]")!.textContent).not.toContain("Owed to you");
    expect(screen.queryByRole("region", { name: "You owe" })).toBeNull();
  });

  it("narrows the entries to a category on its press, and Clear brings them all back", async () => {
    mount();
    await settle();
    const entries = () => within(screen.getByRole("region", { name: /^Entries/ })).getAllByRole("row").length - 1;
    expect(entries()).toBe(NOVEMBER.length);
    fireEvent.click(within(screen.getByRole("region", { name: "By category" })).getByRole("button", { name: /^Travel/ }));
    expect(screen.getByRole("heading", { name: "Entries in Travel" })).toBeTruthy();
    expect(entries()).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("heading", { name: "Entries" })).toBeTruthy();
    expect(entries()).toBe(NOVEMBER.length);
  });

  it("opens a row in the entry dialog, saves it on Return with the row it saw, and closes on Escape", async () => {
    mount();
    await settle();
    const row = NOVEMBER[1];
    fireEvent.click(screen.getByRole("button", { name: /^Corner Fuel, \$42\.10, Nov 20, 2026/ }));
    const dialog = await screen.findByRole("dialog", { name: "Entry" });
    const amount = within(dialog).getByLabelText("Amount") as HTMLInputElement;
    expect(amount.value).toBe("42.10");
    expect(document.activeElement).toBe(amount);
    fireEvent.change(amount, { target: { value: "43.00" } });
    fireEvent.keyDown(within(dialog).getByLabelText("For"), { key: "Enter" });
    await settle();
    expect(asked("work.money.entry")).toEqual([
      { workspaceId: "ws", at: { ref: row.ref, row: row.row, sig: sigOf(row) }, fields: expect.objectContaining({ amount: 4300, date: "2026-11-20", who: "Corner Fuel", way: "out", status: "Paid" }) },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(asked("work.money.read").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: /^Corner Fuel, \$42\.10/ }));
    const again = await screen.findByRole("dialog", { name: "Entry" });
    fireEvent.keyDown(again, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(asked("work.money.entry")).toHaveLength(1);
  });

  it("keeps Save off without an amount or a date", async () => {
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Entry…" }));
    const dialog = await screen.findByRole("dialog", { name: "New entry" });
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Amount"), { target: { value: "12.50" } });
    expect(save.disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: "" } });
    expect(save.disabled).toBe(true);
    fireEvent.keyDown(within(dialog).getByLabelText("Amount"), { key: "Enter" });
    await settle();
    expect(asked("work.money.entry")).toEqual([]);
  });

  it("says the ledger changed and reads again when a write names a row that moved", async () => {
    host.answer = (method) => (method === "work.money.entry" ? { changed: true } : null);
    mount();
    await settle();
    const before = asked("work.money.read").length;
    fireEvent.click(screen.getByRole("button", { name: /^Corner Fuel, \$42\.10/ }));
    const dialog = await screen.findByRole("dialog", { name: "Entry" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    expect(toast).toHaveBeenCalledWith(CHANGED_WORDS);
    expect(asked("work.money.read").length).toBe(before + 1);
  });

  it("sends Paid with the open row as the window saw it", async () => {
    mount();
    await settle();
    const owed = within(screen.getByRole("region", { name: "You owe" }));
    fireEvent.click(owed.getByRole("button", { name: "Paid: State Officials Assn" }));
    await settle();
    const dues = NOVEMBER.find((r) => r.who === "State Officials Assn")!;
    expect(asked("work.money.paid")).toEqual([{ workspaceId: "ws", at: { ref: dues.ref, row: dues.row, sig: sigOf(dues) } }]);
  });

  it("offers Add entry on an empty ledger, which opens the dialog", async () => {
    host.read = (p) => EMPTY_READ(p);
    mount();
    await settle();
    expect(screen.getByText("No money yet")).toBeTruthy();
    expect(screen.getByText("Drop a receipt here.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add entry" }));
    expect(await screen.findByRole("dialog", { name: "New entry" })).toBeTruthy();
  });

  it("says a period with nothing in it in one line, and keeps the figures", async () => {
    setMoneyPeriod({ span: "month", year: 2026, month: 12 });
    mount();
    await settle();
    expect(screen.getByText("Nothing in December 2026")).toBeTruthy();
    expect(document.querySelector("[data-money-figures]")).toBeTruthy();
  });

  it("restores the ledger's columns on the problem's one press", async () => {
    host.read = (p) => readOf(p, ALL_ROWS, { problems: [{ kind: "columns", missing: ["In", "Out"], renamed: [] }] });
    host.answer = (method) => (method === "work.money.open" ? { ledger: {}, mileage: {} } : null);
    mount();
    await settle();
    expect(screen.getByText("The ledger's columns changed")).toBeTruthy();
    expect(screen.getByText("No In or Out column")).toBeTruthy();
    // A broken header is not an empty job, and its zeros are not the job's figures.
    expect(screen.queryByText("No money yet")).toBeNull();
    expect(document.querySelector("[data-money-figures]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore columns" }));
    await settle();
    expect(asked("work.money.open")).toEqual([{ workspaceId: "ws", restore: true }]);
  });

  it("lists the header's verbs, and opens Export for the period's year", async () => {
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect((await screen.findAllByRole("menuitem")).map((m) => m.textContent)).toEqual(["Open ledger", "Open mileage log", "Export…", "Mileage rate…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Export…" }));
    expect(await screen.findByRole("dialog", { name: "Export" })).toBeTruthy();
  });

  it("offers Purchase request… in Add only in a Purdue job", async () => {
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findAllByRole("menuitem")).map((m) => m.textContent)).toEqual(["Receipt…", "Entry…", "Trip…", "Invoice…"]);
    cleanup();
    const purdue = { ...(props as object), sector: "purdue" } as never;
    render(<Head {...purdue} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findAllByRole("menuitem")).map((m) => m.textContent)).toEqual(["Receipt…", "Entry…", "Trip…", "Invoice…", "Purchase request…"]);
  });

  it("keeps the last read under a failed one, with Retry", async () => {
    mount();
    await settle();
    host.read = () => {
      throw new Error("The box did not answer");
    };
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(screen.getByText("Money did not load")).toBeTruthy();
    expect(document.querySelector("[data-money-figures]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
