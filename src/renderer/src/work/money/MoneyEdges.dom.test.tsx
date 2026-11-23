// @vitest-environment jsdom
/**
 * The council's second round, held: every write that only waits as a
 * suggestion says so (an invoice's row, a trip's pay or log row, restored
 * columns); a drop shows it is still travelling; a row with money both ways
 * shows both and is read only; a held Return never saves twice; a picture
 * the browser cannot draw says so with Retry; the rate goes back as it came;
 * a file is a receipt exactly when the host will take it; Skip can be undone;
 * a job with money in another period is not empty.
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
const { rateText } = await import("./RateDialog");
const { BOTH_WAYS } = await import("./money.fixtures");
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

describe("a write that only waits as a suggestion", () => {
  it("says an invoice's row waits, as the one created toast's second line", async () => {
    host.answer = (method) => {
      if (method === "work.money.invoiceNext") return { number: "1042", from: { name: "Ridgeline Officiating", address: "", pay: "" }, dueDays: 14 };
      if (method === "work.money.invoice") return { name: "Invoice 1042 Harlan.pdf", html: "<p/>" };
      if (method === "work.formats.print") return { name: "x", data: btoa("pdf"), warnings: [] };
      if (method === "work.money.keep") return { source: { at: "file", host: "box", path: "/m/Invoices/Invoice 1042 Harlan.pdf" }, receipt: "Invoices/Invoice 1042 Harlan.pdf", acted: { ok: true, ref: "r", row: 40, suggested: true } };
      return method === "work.money.state" ? { host: "box", jobs: [] } : null;
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
    await settle();
    await settle();
    await settle();
    // One press, one toast: the created toast carries the row's wait as its second line.
    expect(toast.mock.calls.map((c) => c[0])).toEqual(["Invoice 1042 created"]);
    expect(toast).toHaveBeenCalledWith("Invoice 1042 created", expect.objectContaining({ description: "Its row waits in the ledger for you to accept.", action: expect.objectContaining({ label: "Send…" }) }));
  });

  it("says a trip's pay or log row waits, from Add → Trip…, once", async () => {
    host.answer = (method) => {
      if (method === "work.money.events") return { events: [] };
      if (method === "work.money.trip") return { pay: { ok: true, ref: "r", row: 50, suggested: true }, trip: { row: 3, ref: "m", value: 1680, suggested: true } };
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
    await settle();
    expect(toast.mock.calls.filter((c) => c[0] === SUGGESTED_WORDS)).toHaveLength(1);
  });

  it("says restored columns wait on the line itself, which offers Open ledger in place of Restore, also after a visit elsewhere", async () => {
    host.read = (p) => readOf(p, [], { problems: [{ kind: "columns", missing: ["In", "Out"], renamed: [] }] });
    host.answer = (method) => (method === "work.money.open" ? { ledger: {}, mileage: {}, suggested: true } : null);
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Restore columns" }));
    await settle();
    await settle();
    // The line says it and holds Open ledger; no toast says it twice.
    expect(toast).not.toHaveBeenCalled();
    expect(screen.getByText("Restored as a suggestion: accept it in the ledger")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore columns" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open ledger" })).toBeTruthy();
    // Remembered for the job: back again, Restore is still not offered.
    cleanup();
    mount();
    await settle();
    expect(screen.queryByRole("button", { name: "Restore columns" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open ledger" })).toBeTruthy();
  });
});

describe("a drop on its way", () => {
  it("shows a loading toast until the host has the files, then lets it go", async () => {
    mount();
    await settle();
    const view = document.querySelector("[data-money-view]")!;
    const files = [new File(["x"], "a.jpg", { type: "image/jpeg" }), new File(["y"], "b.pdf", { type: "application/pdf" })];
    fireEvent.drop(view, { dataTransfer: { types: ["Files"], files } });
    await settle();
    await settle();
    expect(toast.loading).toHaveBeenCalledWith("Filing 2 receipts…");
    expect(toast.dismiss).toHaveBeenCalledWith("t");
    toast.loading.mockClear();
    host.answer = (method) => {
      if (method === "work.money.receive") throw new Error("The box is full");
      return null;
    };
    fireEvent.drop(view, { dataTransfer: { types: ["Files"], files: [files[0]] } });
    await settle();
    await settle();
    expect(toast.loading).toHaveBeenCalledWith("Filing a receipt…");
    expect(toast.error).toHaveBeenCalledWith("a.jpg: The box is full", { id: "t" });
  });

  it("files a picture with no extension under its type's, and leaves a file the host would not take", async () => {
    mount();
    await settle();
    const view = document.querySelector("[data-money-view]")!;
    fireEvent.drop(view, { dataTransfer: { types: ["Files"], files: [new File(["x"], "scan", { type: "image/png" }), new File(["x"], "notes", { type: "" })] } });
    await settle();
    await settle();
    expect(asked("work.money.receive").map((r) => r.name)).toEqual(["scan.png"]);
    expect(toast).toHaveBeenCalledWith("Money files pictures and PDFs. 1 file was left out.");
  });
});

describe("a row with money both ways", () => {
  it("shows both sides in one form, the In first, and opens read only with Open ledger", async () => {
    mount();
    await settle();
    const row = document.querySelector(`[data-money-row="${BOTH_WAYS.row}"]`) as HTMLElement;
    const cells = row.querySelectorAll("td");
    // One form, the dialog's.
    expect(cells[3].textContent).toBe("+$30.00 and $20.00");
    fireEvent.click(within(row).getByRole("button", { name: /\+\$30\.00 and \$20\.00/ }));
    const dialog = await screen.findByRole("dialog", { name: "Entry" });
    expect(within(dialog).getByText("This row has money in and money out. Edit it in the ledger.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
    expect((within(dialog).getByLabelText("Who") as HTMLInputElement).closest("fieldset")!.disabled).toBe(true);
    expect(within(dialog.querySelector("[data-slot=dialog-footer]") as HTMLElement).getByRole("button", { name: "Close" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open ledger" }));
    await waitFor(() => expect(asked("work.money.open")).toHaveLength(1));
    expect(asked("work.money.entry")).toEqual([]);
  });
});

describe("Return", () => {
  it("saves on a fresh press, never on a held one", async () => {
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^Corner Fuel, \$42\.10/ }));
    const dialog = await screen.findByRole("dialog", { name: "Entry" });
    fireEvent.keyDown(within(dialog).getByLabelText("For"), { key: "Enter", repeat: true });
    await settle();
    expect(asked("work.money.entry")).toEqual([]);
    fireEvent.keyDown(within(dialog).getByLabelText("For"), { key: "Enter" });
    await settle();
    expect(asked("work.money.entry")).toHaveLength(1);
  });
});

describe("a picture the browser cannot draw", () => {
  it("goes to the failed state with Retry, at the column's height", async () => {
    host.read = (p) => readOf(p, undefined, { toConfirm: [waiting("a", { picture: true })] });
    host.answer = (method) => (method === "work.money.picture" ? { mime: "image/png", name: "a.png", size: 3, parts: 1, dataBase64: "AAAA" } : method === "work.money.state" ? { host: "box", jobs: [] } : null);
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Review Shop a" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector("[data-receipt-picture] img")).toBeTruthy());
    fireEvent.error(dialog.querySelector("[data-receipt-picture] img")!);
    await waitFor(() => expect(within(dialog).getByText("The picture did not load")).toBeTruthy());
    expect(dialog.querySelector("[data-receipt-picture=failed]")!.className).toContain("h-[420px]");
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("the mileage rate", () => {
  it("goes back as it came, padded and never rounded", async () => {
    expect(rateText(0.7251)).toBe("0.7251");
    expect(rateText(0.7)).toBe("0.70");
    expect(rateText(1)).toBe("1.00");
    host.read = (p) => ({ ...readOf(p), rate: { year: 2026, rate: 0.7251, own: true } });
    mount();
    await settle();
    fireEvent.click(within(screen.getByTestId("head")).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mileage rate…" }));
    const dialog = await screen.findByRole("dialog", { name: "Mileage rate for 2026" });
    expect((within(dialog).getByLabelText("Per mile") as HTMLInputElement).value).toBe("0.7251");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    expect(asked("work.money.rate")).toEqual([{ workspaceId: "ws", year: 2026, rate: 0.7251 }]);
  });
});

describe("Skip", () => {
  it("says what it skipped, with Undo", async () => {
    host.read = (p) => readOf(p, undefined, { calendar: [offer("e1", { title: "Varsity at Harrison HS" })] });
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "More for Varsity at Harrison HS" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Skip" }));
    await settle();
    expect(toast).toHaveBeenCalledWith("Skipped Varsity at Harrison HS", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }));
    (toast.mock.calls.at(-1)![1] as { action: { onClick: () => void } }).action.onClick();
    await settle();
    expect(asked("work.money.skip")).toEqual([
      { workspaceId: "ws", eventId: "e1" },
      { workspaceId: "ws", eventId: "e1", undo: true },
    ]);
  });
});

describe("an empty period of a job with money", () => {
  it("is not No money yet when the job has money in another period, and a job known bare opens bare", async () => {
    host.read = (p) => readOf(p, [], { any: true });
    mount();
    await settle();
    expect(screen.queryByText("No money yet")).toBeNull();
    expect(screen.getByText("Nothing in November 2026")).toBeTruthy();
    cleanup();
    host.read = (p) => EMPTY_READ(p);
    mount();
    await settle();
    expect(screen.getByText("No money yet")).toBeTruthy();
    cleanup();
    // Known bare: the next visit draws no stepper even before its read lands.
    host.read = () => new Promise(() => {});
    mount();
    expect(within(screen.getByTestId("head")).queryByRole("button", { name: "Previous month" })).toBeNull();
  });
});
