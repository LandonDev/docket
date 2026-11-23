// @vitest-environment jsdom
/**
 * The council's third round, held: a paste goes through the drop's intake
 * and says what it leaves out; the read-only dialog of a row with money both
 * ways always shows its stored status; Owed offers Open ledger, not Paid, on
 * such a row; a renamed header is named, with Open ledger and no Restore; a
 * trip already added keeps its form open, saying so; an invoice needs who it
 * is from; Add all says its reach and a suggestion once; the period shows
 * only once the job is known to have money; the host's refusal of an accept
 * shows on the dialog's error line.
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


const paste = (target: EventTarget, files: File[]) => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files } });
  target.dispatchEvent(event);
};

describe("a paste", () => {
  it("goes through the drop's intake: nothing Money files is said, and a mixed paste says how many were left out", async () => {
    mount();
    await settle();
    const view = document.querySelector("[data-money-view]")!;
    paste(view, [new File(["x"], "notes.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]);
    await settle();
    expect(toast).toHaveBeenCalledWith("Money files pictures and PDFs.");
    expect(asked("work.money.receive")).toEqual([]);
    toast.mockClear();
    paste(view, [new File(["x"], "shot.png", { type: "image/png" }), new File(["x"], "a.zip", { type: "application/zip" })]);
    await settle();
    await settle();
    expect(toast).toHaveBeenCalledWith("Money files pictures and PDFs. 1 file was left out.");
    expect(asked("work.money.receive").map((r) => r.name)).toEqual(["shot.png"]);
    toast.mockClear();
    // A paste with no files is left alone.
    paste(view, []);
    await settle();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("a row with money both ways", () => {
  it("shows its stored status as text in the read-only dialog, To reimburse too", async () => {
    const row = { ...BOTH_WAYS, status: "To reimburse" as const };
    host.read = (p) => readOf(p, [row]);
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /\+\$30\.00 and \$20\.00/ }));
    const dialog = await screen.findByRole("dialog", { name: "Entry" });
    expect((within(dialog).getByLabelText("Status") as HTMLInputElement).value).toBe("To reimburse");
  });

  it("offers Open ledger in Owed, never a Paid that would settle the other side", async () => {
    host.read = (p) => readOf(p, [{ ...BOTH_WAYS, status: "Unpaid" as const }]);
    mount();
    await settle();
    for (const group of ["Owed to you", "You owe"]) {
      const region = within(screen.getByRole("region", { name: group }));
      expect(region.queryByRole("button", { name: /^Paid/ })).toBeNull();
      expect(region.getByRole("button", { name: /^Open ledger/ })).toBeTruthy();
    }
    fireEvent.click(within(screen.getByRole("region", { name: "You owe" })).getByRole("button", { name: /^Open ledger/ }));
    await waitFor(() => expect(asked("work.money.open")).toHaveLength(1));
    expect(asked("work.money.paid")).toEqual([]);
  });
});

describe("a renamed header", () => {
  it("names what is gone and where his figures likely are, with Open ledger and no Restore", async () => {
    host.read = (p) => readOf(p, [], { problems: [{ kind: "columns", missing: ["Out"], renamed: ["Spent"] }] });
    mount();
    await settle();
    expect(screen.getByText("No Out column: Spent may be it, name it back in the ledger")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore columns" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open ledger" }));
    await waitFor(() => expect(asked("work.money.open")).toEqual([{ workspaceId: "ws" }]));
  });
});

describe("a trip already added", () => {
  it("keeps an event's form open with the error line, as nothing was written", async () => {
    host.answer = (method) => (method === "work.money.events" ? { events: [] } : method === "work.money.trip" ? { already: true, pay: null, trip: null } : null);
    const { openMoneyDialog } = await import("./MoneyView");
    mount();
    await settle();
    act(() => openMoneyDialog({ kind: "trip", offer: offer("e1", { title: "Varsity at Harrison HS" }) }));
    const dialog = await screen.findByRole("dialog", { name: "Trip" });
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await settle();
    expect(asked("work.money.trip")[0]).toMatchObject({ eventId: "e1" });
    expect(within(dialog).getByText("That event was already added.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Trip" })).toBe(dialog);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("an invoice", () => {
  it("keeps Create off until it says who it is from", async () => {
    host.answer = (method) => (method === "work.money.invoiceNext" ? { number: "1001", from: null, dueDays: 14 } : null);
    mount();
    await settle();
    fireEvent.click(within(screen.getByTestId("head")).getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Invoice…" }));
    const dialog = await screen.findByRole("dialog", { name: "Invoice" });
    await settle();
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "Harlan Valley Officials" } });
    fireEvent.change(within(dialog).getByLabelText("What, line 1"), { target: { value: "Varsity games" } });
    fireEvent.change(within(dialog).getByLabelText("Rate, line 1"), { target: { value: "75" } });
    const create = within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Business name"), { target: { value: "Ridgeline Officiating" } });
    expect(create.disabled).toBe(false);
  });
});

describe("Add all", () => {
  it("says a suggestion once, after the last offer", async () => {
    host.read = (p) => readOf(p, undefined, { calendar: [offer("e1"), offer("e2"), offer("e3")] });
    host.answer = (method) => (method === "work.money.trip" ? { pay: { ok: true, ref: "r", row: 50, suggested: true }, trip: { row: 3, ref: "m", value: 1680, suggested: true } } : null);
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add all" }));
    for (let i = 0; i < 4; i++) await settle();
    expect(asked("work.money.trip")).toHaveLength(3);
    expect(toast.mock.calls.filter((c) => c[0] === SUGGESTED_WORDS)).toHaveLength(1);
  });
});

describe("the header", () => {
  it("draws no period on a first visit until the job is known to have money, nor in a columns fault", async () => {
    const fresh = { ...(props as object), workspace: { id: "ws-new", environmentId: "box", name: "New job", kind: "work", sector: "ref" } } as never;
    let land: (r: MoneyRead) => void = () => {};
    host.read = (p) => new Promise((done) => (land = () => done(readOf(p))));
    render(
      <>
        <div data-testid="fresh-head">
          <Head {...fresh} />
        </div>
        <View {...fresh} />
      </>,
    );
    await settle();
    expect(within(screen.getByTestId("fresh-head")).queryByRole("button", { name: "Previous month" })).toBeNull();
    await act(async () => land(readOf({ from: "2026-11-01", to: "2026-12-01" })));
    await settle();
    expect(within(screen.getByTestId("fresh-head")).getByRole("button", { name: "Previous month" })).toBeTruthy();
    cleanup();
    host.read = (p) => readOf(p, [], { problems: [{ kind: "columns", missing: ["In", "Out"], renamed: [] }] });
    mount();
    await settle();
    expect(within(screen.getByTestId("head")).queryByRole("button", { name: "Previous month" })).toBeNull();
  });
});

describe("the host's refusal of an accept", () => {
  it("shows on the confirm dialog's error line", async () => {
    host.read = (p) => readOf(p, undefined, { toConfirm: [waiting("a")] });
    host.answer = (method) => {
      if (method === "work.money.accept") throw new Error("The ledger has no Receipt column, so the file cannot be named in it");
      return method === "work.money.state" ? { host: "box", jobs: [] } : null;
    };
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Review Shop a" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm receipt" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    expect(within(dialog).getByText("The ledger has no Receipt column, so the file cannot be named in it")).toBeTruthy();
  });
});
