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
const opens = vi.hoisted(() => new Set<() => void>());
/** The link to the host comes back after a cut: what was missed is read once. */
const reopen = (): void => {
  for (const open of [...opens]) open();
};
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      onPush: () => () => {},
      onOpen: (listener: () => void) => (opens.add(listener), () => void opens.delete(listener)),
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

// The dialog's rules by the date field's value; the field itself is proven in components/ui and work/dateField.dom.test.tsx.
vi.mock("../../components/ui/date-field", async () => ({ DateField: (await import("../../work/testDateField")).DateFieldStandIn }));
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

describe("the Money view's reads (perf M10)", () => {
  it("reads at most once on five focus events in a minute, and once when the link comes back", async () => {
    mount();
    await settle();
    const reads = asked("work.money.read").length;
    const start = Date.now();
    const clock = vi.spyOn(Date, "now");
    for (let i = 0; i < 5; i++) {
      clock.mockReturnValue(start + 1_000 + i * 12_000);
      await act(async () => void window.dispatchEvent(new Event("focus")));
    }
    clock.mockReturnValue(start + 61_000);
    await act(async () => void window.dispatchEvent(new Event("focus")));
    clock.mockRestore();
    await settle();
    expect(asked("work.money.read").length).toBe(reads + 1);
    // A paid row while the link was down shows after it reopens.
    host.read = (p) => readOf(p, ALL_ROWS.map((r) => ({ ...r, status: "Paid" as const })));
    await act(async () => reopen());
    await settle();
    expect(asked("work.money.read").length).toBe(reads + 2);
    expect(document.querySelector("[data-money-figures]")!.textContent).not.toContain("Owed to you");
  });
});

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
    await act(async () => reopen());
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

  it("sends a new entry under one key for the dialog's life, so a Save pressed again after a lost answer adds one row", async () => {
    let lost = true;
    const before = host.answer;
    host.answer = (method, params) => {
      if (method === "work.money.entry" && lost) {
        lost = false;
        throw new Error("The host did not answer");
      }
      return before(method, params);
    };
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Entry…" }));
    const dialog = await screen.findByRole("dialog", { name: "New entry" });
    fireEvent.change(within(dialog).getByLabelText("Amount"), { target: { value: "12.50" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    const sent = asked("work.money.entry");
    expect(sent).toHaveLength(2);
    expect(typeof sent[0].key).toBe("string");
    expect(sent[1].key).toBe(sent[0].key);
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
    fireEvent.click(owed.getByRole("button", { name: "Paid: State Officials Assn, Second-half dues" }));
    await settle();
    const dues = NOVEMBER.find((r) => r.who === "State Officials Assn")!;
    expect(asked("work.money.paid")).toEqual([{ workspaceId: "ws", at: { ref: dues.ref, row: dues.row, sig: sigOf(dues) } }]);
  });

  /** Council round 1, sitting E (R1-E8): with the link cut, Paid on a kept row still sent a request the host could only refuse. */
  it("holds Paid and Open ledger in place while the link is down", async () => {
    const { registry: links } = await import("../../lib/connection/registry");
    const { IDLE_STATUS } = await import("../../lib/connection/types");
    let transport: "open" | "offline" = "open";
    vi.spyOn(links, "statusOf").mockImplementation((id) => (id === "box" ? { ...IDLE_STATUS, transport } : IDLE_STATUS));
    vi.spyOn(links, "environment").mockReturnValue({ name: "The box" } as never);
    const shown = mount();
    await settle();
    const paid = () => within(screen.getByRole("region", { name: "You owe" })).getByRole<HTMLButtonElement>("button", { name: "Paid: State Officials Assn, Second-half dues" });
    expect(paid().disabled).toBe(false);
    transport = "offline";
    shown.rerender(
      <>
        <div role="toolbar" aria-label="Money header">
          <Head {...props} />
        </div>
        <View {...props} />
      </>,
    );
    expect(paid().disabled).toBe(true);
    vi.restoreAllMocks();
  });

  /** Council round 1, sitting E (R1-E7): the ring hugged the date's link; the row is the press, so the ring is the row's. */
  it("rings the whole row on focus, never the date alone", async () => {
    mount();
    await settle();
    const press = document.querySelector("[data-money-row] button")!;
    expect(press.className).toContain("outline-none!");
    expect(press.className).toContain("focus-visible:after:outline-accent");
    expect(press.className).toContain("after:inset-0");
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
    // What to rename is never cut: the detail wraps under the word in a narrow pane (council round 2, sitting E).
    expect(screen.getByText("No In or Out column").className).not.toContain("truncate");
    expect(screen.getByText("No In or Out column").closest("p")!.className).toContain("text-pretty");
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

  it("under 520px moves Month or Year into More, so Add and More stay in the header", async () => {
    // jsdom lays nothing out: the header's width is given, and the observer told it changed.
    // Only the header's watcher is told: other parts' observers (the menu's) keep their own calls.
    const watchers: { fn: (entries: unknown[]) => void; at: Element | null }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      w: { fn: (entries: unknown[]) => void; at: Element | null };
      constructor(fn: (entries: unknown[]) => void) {
        this.w = { fn, at: null };
        watchers.push(this.w);
      }
      observe(at: Element) {
        this.w.at = at;
      }
      unobserve() {}
      disconnect() {}
    });
    // The observer tells the header's content box, fractional, as the layout has it.
    const resize = (width: number): void => watchers.filter((w) => w.at === document.querySelector("[aria-label='Money header']")).forEach((w) => w.fn([{ contentRect: { width } }]));
    const choices = async (): Promise<string[]> => {
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      await screen.findAllByRole("menuitem");
      const said = screen.queryAllByRole("menuitemcheckbox").map((m) => m.textContent!);
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await settle();
      return said;
    };
    try {
      mount();
      await settle();
      // Sol round 4: a 543.75px header is 519.75px of content, so the toggle is hidden and More holds the choices.
      act(() => resize(519.75));
      expect(await choices()).toEqual(["Month", "Year"]);
      // Measured inside the header's padding, as its container query is (Sol round 3 P2): 532px is 508px of content.
      act(() => resize(508));
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      expect((await screen.findAllByRole("menuitemcheckbox")).map((m) => m.textContent)).toEqual(["Month", "Year"]);
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Year" }));
      await settle();
      expect(document.querySelector("[data-money-period]")?.textContent).toMatch(/^\d{4}$/);
      // At 520px of content the toggle holds them and More does not say them twice.
      act(() => resize(520));
      expect(await choices()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("under 640px folds Category into Who's second line (the view's container query)", async () => {
    mount();
    await settle();
    expect(screen.getByRole("columnheader", { name: "Category" }).className).toContain("@max-[640px]/money:hidden");
    const row = document.querySelector("[data-money-row]")!;
    const second = row.querySelector("td:nth-child(2) span:nth-child(2)");
    expect(second?.className).toContain("@max-[640px]/money:block");
    expect(second?.textContent).toBe(row.querySelector("td:nth-child(3)")?.textContent);
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

  it("shows only the failed read when the last read was empty: never \"No money yet\" with its Add entry under it", async () => {
    host.read = EMPTY_READ;
    mount();
    await settle();
    expect(screen.getByText("No money yet")).toBeTruthy();
    host.read = () => { throw new Error("The box did not answer"); };
    await act(async () => reopen());
    await settle();
    expect(screen.getByText("Money did not load")).toBeTruthy();
    expect(screen.queryByText("No money yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add entry" })).toBeNull();
    host.read = EMPTY_READ;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByText("No money yet")).toBeTruthy();
  });

  it("keeps the last read under a failed one, with Retry", async () => {
    mount();
    await settle();
    host.read = () => {
      throw new Error("The box did not answer");
    };
    await act(async () => reopen());
    await settle();
    expect(screen.getByText("Money did not load")).toBeTruthy();
    expect(document.querySelector("[data-money-figures]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
