// @vitest-environment jsdom
/**
 * After the council's fourth round: the read-only dialog's Open ledger waits
 * for the host and stays on a refusal; the year's hover says the true sum; Add
 * all reads again however it ended; Owed's verbs end on one edge; the loading
 * bones sit on Entries' columns; a hand-typed trip's `already` is its own Add
 * landing; the rate seeds in plain decimals; a mileage log that cannot be
 * opened, or leads out of the job, never stops Open ledger; a ledger that
 * leads out of the job is a failed read, never an empty job.
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
const { MILEAGE_OUTSIDE_WORDS } = await import("./api");
const { REFUND, readOf } = await import("./money.fixtures");
const { byMonthBars, trueRows, openMoneyDialog } = await import("./MoneyView");
const { ChartTooltipContent } = await import("@aliax/charts/tooltip");
const { formatMoney } = await import("@shared/work/money");

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


const LEDGER = { at: "file", host: "box", path: "/home/ref/Refereeing/Money/Ledger.tcsheet" };

describe("the read-only dialog's Open ledger", () => {
  it("waits for the host with the dialog open, says a refusal in its own line, and on success closes and lets the row go", async () => {
    let refuse = true;
    host.answer = (method) => {
      if (method === "work.money.open") {
        if (refuse) throw new Error("The box did not answer");
        return { ledger: LEDGER, mileage: null };
      }
      return null;
    };
    mount();
    await settle();
    const openRow = async () => {
      const row = document.querySelector(`[data-money-row="${REFUND.row}"]`) as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: /-\$20\.00 out/ }));
      return screen.findByRole("dialog", { name: "Entry" });
    };
    let dialog = await openRow();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open ledger" }));
    // In flight: the dialog is still there, and Close waits.
    expect(screen.getByRole("dialog", { name: "Entry" })).toBe(dialog);
    const footer = dialog.querySelector("[data-slot=dialog-footer]") as HTMLElement;
    expect((within(footer).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    await settle();
    expect(within(dialog).getByText("The box did not answer")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Entry" })).toBe(dialog);
    expect(toast.error).not.toHaveBeenCalled();
    refuse = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Open ledger" }));
    await settle();
    await waitFor(() => expect(asked("work.files.open")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Entry" })).toBeNull());
    // Let go: the same row opens afresh.
    dialog = await openRow();
    expect(within(dialog).queryByText("The box did not answer")).toBeNull();
    expect((within(dialog).getByRole("button", { name: "Open ledger" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the year chart's hover", () => {
  it("says the month's true, signed sum while the bar stops at the axis", () => {
    const [bar] = byMonthBars([{ month: 11, in: 0, out: -2000 }]);
    expect(bar.out).toBe(0);
    const payload = [
      { dataKey: "in", name: "In", value: bar.in, payload: bar },
      { dataKey: "out", name: "Out", value: bar.out, payload: bar },
    ];
    render(<ChartTooltipContent active payload={trueRows(payload)} label="Nov" valueFormatter={formatMoney} />);
    const tip = document.querySelector("[data-slot=chart-tooltip]")!;
    expect(tip.textContent).toContain("Out-$20.00");
    expect(tip.textContent).toContain("In$0.00");
  });
});

describe("Add all", () => {
  it("reads again after the batch, also when one offer failed, and the error stays a toast", async () => {
    host.read = (p) => readOf(p, undefined, { calendar: [offer("e1"), offer("e2")] });
    host.answer = (method, params) => {
      if (method === "work.money.trip" && params.eventId === "e2") throw new Error("The box did not answer");
      if (method === "work.money.trip") return { pay: { ok: true, ref: "r", row: 50 }, trip: { row: 3, ref: "m", value: 1680 } };
      return null;
    };
    mount();
    await settle();
    const reads = asked("work.money.read").length;
    fireEvent.click(screen.getByRole("button", { name: "Add all" }));
    await settle();
    await settle();
    expect(asked("work.money.trip")).toHaveLength(2);
    expect(asked("work.money.read").length).toBe(reads + 1);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The box did not answer"));
  });
});

describe("Owed's verbs", () => {
  it("end Paid on the column's edge, the spinner opening to its left", async () => {
    mount();
    await settle();
    const paid = screen.getAllByRole("button", { name: /^Paid: / })[0];
    expect((paid.querySelector("[data-slot=busy-label] > span") as HTMLElement).className).toContain("justify-end");
  });
});

describe("the loading bones", () => {
  it("sit in Entries' own table, on its columns", async () => {
    let land: (r: MoneyRead) => void = () => {};
    host.read = () => new Promise<MoneyRead>((r) => (land = r));
    mount();
    await settle();
    const bones = screen.getByLabelText("Loading money");
    const heads = (root: ParentNode) => Array.from(root.querySelectorAll("th")).map((th) => th.className);
    const boneHeads = heads(bones);
    expect(bones.querySelectorAll("tr[data-money-bone]")).toHaveLength(6);
    expect(bones.querySelector("tr[data-money-bone] td")!.querySelector("[data-slot=skeleton]")).toBeTruthy();
    await act(async () => land(readOf({ from: "2026-11-01", to: "2026-12-01" })));
    await settle();
    const entries = screen.getByRole("region", { name: "Entries" });
    expect(heads(entries)).toEqual(boneHeads);
    // A fixed layout: the columns stand where the header puts them, whatever the rows hold.
    expect(bones.querySelector("table")!.className).toBe(entries.querySelector("table")!.className);
    expect(entries.querySelector("table")!.className).toContain("table-fixed");
  });
});

describe("a trip typed by hand, its answer lost", () => {
  it("takes the host's already for the dialog's own earlier Add: saved, and closed", async () => {
    let first = true;
    host.answer = (method) => {
      if (method === "work.money.events") return { events: [] };
      if (method === "work.money.trip") {
        if (first) {
          first = false;
          throw new Error("The box did not answer");
        }
        return { already: true, pay: null, trip: null };
      }
      return null;
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
    expect(within(dialog).getByText("The box did not answer")).toBeTruthy();
    const reads = asked("work.money.read").length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await settle();
    const keys = asked("work.money.trip").map((t) => t.key);
    expect(keys[1]).toBe(keys[0]);
    expect(within(dialog).queryByText("That event was already added.")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Trip" })).toBeNull());
    expect(asked("work.money.read").length).toBeGreaterThan(reads);
  });
});

describe("the mileage rate", () => {
  it("seeds in plain decimals, never 1e-7, and an untouched Save sends the stored number", async () => {
    host.read = (p) => ({ ...readOf(p), rate: { year: 2026, rate: 1e-7, own: true } });
    host.answer = (method) => (method === "work.money.rate" ? {} : null);
    mount();
    await settle();
    act(() => openMoneyDialog({ kind: "rate" }));
    const dialog = await screen.findByRole("dialog", { name: "Mileage rate for 2026" });
    expect((within(dialog).getByLabelText("Per mile") as HTMLInputElement).value).toBe("0.0000001");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    expect(asked("work.money.rate")).toEqual([{ workspaceId: "ws", year: 2026, rate: 1e-7 }]);
  });
});

describe("a mileage log that cannot be opened", () => {
  it("says so in the miles line's place with Open mileage log", async () => {
    host.read = (p) => readOf(p, undefined, { problems: [{ kind: "mileage", reason: "unreadable", missing: [] }], miles: { miles: 0, value: 0, rate: null } });
    host.answer = (method) => (method === "work.money.open" ? { ledger: LEDGER, mileage: { at: "file", host: "box", path: "/m/Mileage.tcsheet" } } : null);
    mount();
    await settle();
    const line = document.querySelector("[data-mileage-problem]") as HTMLElement;
    expect(line.textContent).toContain("The mileage log could not be read, so its trips are not counted");
    fireEvent.click(within(line).getByRole("button", { name: "Open mileage log" }));
    await waitFor(() => expect(asked("work.files.open")).toEqual([{ workspaceId: "ws", ref: { at: "file", host: "box", path: "/m/Mileage.tcsheet" }, name: "Mileage" }]));
  });

  it("opens nothing for a log that leads outside the job, saying so, from the line or from More; Open ledger works all the same", async () => {
    host.read = (p) => readOf(p, undefined, { problems: [{ kind: "mileage", reason: "unreadable", missing: [] }], miles: { miles: 0, value: 0, rate: null } });
    host.answer = (method) => (method === "work.money.open" ? { ledger: LEDGER, mileage: null } : null);
    mount();
    await settle();
    fireEvent.click(within(document.querySelector("[data-mileage-problem]") as HTMLElement).getByRole("button", { name: "Open mileage log" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MILEAGE_OUTSIDE_WORDS));
    toast.error.mockClear();
    fireEvent.click(within(screen.getByTestId("head")).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open mileage log" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MILEAGE_OUTSIDE_WORDS));
    expect(asked("work.files.open")).toEqual([]);
    fireEvent.click(within(screen.getByTestId("head")).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open ledger" }));
    await waitFor(() => expect(asked("work.files.open")).toEqual([{ workspaceId: "ws", ref: LEDGER, name: "Ledger" }]));
  });
});

describe("a ledger that leads outside the job", () => {
  it("is a failed read in the host's words, never the empty state", async () => {
    const words = "The ledger leads outside this job's folder, so Money does not read it.";
    host.read = () => Promise.reject(new Error(words));
    mount();
    await settle();
    const line = document.querySelector("[data-view-state]") as HTMLElement;
    expect(line.textContent).toContain("Money did not load");
    expect(line.textContent).toContain(words);
    expect(screen.queryByText("No money yet")).toBeNull();
    expect(screen.queryByLabelText("Loading money")).toBeNull();
  });
});
