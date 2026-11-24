// @vitest-environment jsdom
/**
 * The council's first round, held: a cost to be paid back reads as what it
 * was for, never as the seller owing him; the calendar's offers sit under
 * their own name with Add all on that line; a reading receipt has nothing to
 * press; the first drop on a new job is seen; a read belongs to its period;
 * a ledger missing a header has its own body; a suggested write says so; a
 * picture that did not load says so with Retry; a drop of nothing Money
 * takes says so; Discard waits while Save is in flight.
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
const { EMPTY_READ, NOVEMBER, readOf } = await import("./money.fixtures");
const { owedWords } = await import("./MoneyView");

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
  setMoneyPeriod({ span: "month", year: 2026, month: 11 });
  URL.createObjectURL ??= () => "blob:x";
  URL.revokeObjectURL ??= () => {};
});
afterEach(cleanup);

describe("Owed", () => {
  it("leads a cost to be paid back with what it was for, the seller after it, and never as the seller owing him", async () => {
    expect(owedWords({ who: "Diner on 9th", what: "Crew meal", reimburse: true })).toEqual({ lead: "Crew meal", after: "Diner on 9th" });
    expect(owedWords({ who: "Diner on 9th", what: "", reimburse: true })).toEqual({ lead: "Diner on 9th", after: "to be paid back" });
    expect(owedWords({ who: "Harlan Valley Officials", what: "Varsity", reimburse: false })).toEqual({ lead: "Harlan Valley Officials", after: "Varsity" });
    mount();
    await settle();
    const diner = NOVEMBER.find((r) => r.who === "Diner on 9th")!;
    const row = within(screen.getByRole("region", { name: "Owed to you" })).getByText("Crew meal before the game").closest("li")!;
    expect(row.getAttribute("data-owed-row")).toBe(String(diner.row));
    expect(row.textContent).toMatch(/^Crew meal before the gameDiner on 9th/);
  });
});

describe("To confirm", () => {
  it("puts the calendar's offers under their own name, Add all on that line, and nothing to press on a reading receipt", async () => {
    host.read = (p) => readOf(p, undefined, { toConfirm: [waiting("a"), waiting("b", { state: "reading" })], calendar: [offer("e1"), offer("e2")] });
    mount();
    await settle();
    const section = screen.getByRole("region", { name: "To confirm" });
    expect(within(section).getAllByRole("heading").map((h) => h.textContent)).toEqual(["To confirm", "From the calendar"]);
    const calendar = within(section).getByRole("group", { name: "From the calendar" });
    expect(within(calendar).getByRole("button", { name: "Add all" })).toBeTruthy();
    const reading = section.querySelector("[data-to-confirm=b]") as HTMLElement;
    expect(within(reading).queryAllByRole("button")).toEqual([]);
    fireEvent.click(within(calendar).getByRole("button", { name: "Add all" }));
    await settle();
    await settle();
    expect(asked("work.money.trip").map((t) => t.eventId)).toEqual(["e1", "e2"]);
  });

  it("names the group even when only offers wait, and drops a this-year receipt's year", async () => {
    host.read = (p) => readOf(p, undefined, { calendar: [offer("e1")] });
    mount();
    await settle();
    expect(within(screen.getByRole("region", { name: "To confirm" })).getByRole("heading", { name: "From the calendar" })).toBeTruthy();
    cleanup();
    host.read = (p) => readOf(p, undefined, { toConfirm: [waiting("a", { fields: { amount: 4210, date: `${new Date().getFullYear()}-03-04`, who: "Corner Fuel", category: null } })] });
    mount();
    await settle();
    expect((document.querySelector("[data-to-confirm=a]") as HTMLElement).textContent).toContain("Mar 4");
    expect((document.querySelector("[data-to-confirm=a]") as HTMLElement).textContent).not.toContain(String(new Date().getFullYear()));
  });
});

describe("the empty job", () => {
  it("shows what waits on a job with no ledger, not No money yet, and hides the period until there is money", async () => {
    host.read = (p) => ({ ...EMPTY_READ(p), toConfirm: [waiting("a")] });
    mount();
    await settle();
    expect(screen.queryByText("No money yet")).toBeNull();
    expect(screen.getByRole("region", { name: "To confirm" })).toBeTruthy();
    expect(document.querySelector("[data-money-figures]")!.textContent).toContain("$0.00");
    cleanup();
    host.read = (p) => EMPTY_READ(p);
    mount();
    await settle();
    expect(screen.getByText("No money yet")).toBeTruthy();
    expect(within(screen.getByTestId("head")).queryByRole("button", { name: "Previous month" })).toBeNull();
    expect(within(screen.getByTestId("head")).queryByRole("button", { name: "Year" })).toBeNull();
  });
});

describe("a read belongs to its period", () => {
  it("shows the bones, not the old month's figures, until the new month answers", async () => {
    mount();
    await settle();
    expect(document.querySelector("[data-money-figures]")).toBeTruthy();
    let land: (r: MoneyRead) => void = () => {};
    host.read = (p) => new Promise((done) => (land = () => done(readOf(p))));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await settle();
    expect(document.querySelector("[data-money-figures]")).toBeNull();
    expect(screen.getByLabelText("Loading money")).toBeTruthy();
    await act(async () => land(readOf({ from: "2026-10-01", to: "2026-11-01" })));
    await settle();
    expect(document.querySelector("[data-money-figures]")).toBeTruthy();
  });

  it("keeps no other period's figures under a failed read", async () => {
    mount();
    await settle();
    host.read = () => {
      throw new Error("The box did not answer");
    };
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await settle();
    expect(screen.getByText("Money did not load")).toBeTruthy();
    expect(document.querySelector("[data-money-figures]")).toBeNull();
    expect(screen.queryByLabelText("Loading money")).toBeNull();
  });
});

describe("a ledger missing a header", () => {
  it("is the line over To confirm and nothing else", async () => {
    host.read = (p) => readOf(p, [], { problems: [{ kind: "columns", missing: ["Date"], renamed: [] }], toConfirm: [waiting("a")] });
    mount();
    await settle();
    expect(screen.getByText("No Date column")).toBeTruthy();
    expect(screen.getByRole("region", { name: "To confirm" })).toBeTruthy();
    expect(document.querySelector("[data-money-figures]")).toBeNull();
    expect(screen.queryByRole("region", { name: /^Entries/ })).toBeNull();
    expect(screen.queryByText("No money yet")).toBeNull();
  });
});

describe("a suggested write", () => {
  it("is said as a suggestion with Open ledger, never as saved", async () => {
    host.answer = (method) => (method === "work.money.paid" ? { ok: true, ref: "r", row: 2, suggested: true } : null);
    mount();
    await settle();
    fireEvent.click(within(screen.getByRole("region", { name: "You owe" })).getByRole("button", { name: /^Paid/ }));
    await settle();
    expect(toast).toHaveBeenCalledWith(SUGGESTED_WORDS, expect.objectContaining({ action: expect.objectContaining({ label: "Open ledger" }) }));
  });
});

describe("the confirm dialog", () => {
  it("says a picture that did not load, with Retry that asks again", async () => {
    let fail = true;
    host.read = (p) => readOf(p, undefined, { toConfirm: [waiting("a", { picture: true })] });
    host.answer = (method) => {
      if (method === "work.money.picture") {
        if (fail) throw new Error("The file moved");
        return { mime: "image/png", name: "a.png", size: 3, parts: 1, dataBase64: "AAAA" };
      }
      return method === "work.money.state" ? { host: "box", jobs: [] } : null;
    };
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Review Shop a" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("The picture did not load")).toBeTruthy());
    fail = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dialog.querySelector("[data-receipt-picture] img")).toBeTruthy());
  });

  it("holds Discard while Save is in flight", async () => {
    let land: (v: unknown) => void = () => {};
    host.read = (p) => readOf(p, undefined, { toConfirm: [waiting("a")] });
    host.answer = (method) => (method === "work.money.accept" ? new Promise((done) => (land = done)) : method === "work.money.state" ? { host: "box", jobs: [] } : null);
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Review Shop a" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm receipt" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    expect((within(dialog).getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => land({ ok: true, ref: "r", row: 9 }));
  });
});

describe("a receipt filed elsewhere while its dialog is open", () => {
  it("moves on when Discard finds it already filed, saying so with no Undo", async () => {
    host.read = (p) => readOf(p, undefined, { toConfirm: [waiting("a")] });
    host.answer = (method) => (method === "work.money.drop" ? { dropped: false } : method === "work.money.state" ? { host: "box", jobs: [] } : null);
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Review Shop a" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm receipt" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm receipt" })).toBeNull());
    expect(toast).toHaveBeenCalledWith("Shop a was already filed");
  });
});

describe("drops", () => {
  const drop = (files: File[]) => {
    const view = document.querySelector("[data-money-view]")!;
    fireEvent.dragOver(view, { dataTransfer: { types: ["Files"], files, dropEffect: "none" } });
    fireEvent.drop(view, { dataTransfer: { types: ["Files"], files } });
  };

  it("says when nothing dropped is a picture or a PDF, and how many were left out of a mixed drop", async () => {
    mount();
    await settle();
    drop([new File(["x"], "notes.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]);
    await settle();
    expect(toast).toHaveBeenCalledWith("Money files pictures and PDFs.");
    expect(asked("work.money.receive")).toEqual([]);
    toast.mockClear();
    drop([new File(["x"], "fuel.heic", { type: "" }), new File(["x"], "a.zip", { type: "application/zip" }), new File(["x"], "b.txt", { type: "text/plain" })]);
    await settle();
    await settle();
    expect(toast).toHaveBeenCalledWith("Money files pictures and PDFs. 2 files were left out.");
    expect(asked("work.money.receive").map((r) => r.name)).toEqual(["fuel.heic"]);
  });

  it("takes a pasted picture only inside the view or with nothing focused", async () => {
    mount();
    await settle();
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    const paste = (target: EventTarget) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { files: [new File(["x"], "shot.png", { type: "image/png" })] } });
      target.dispatchEvent(event);
    };
    paste(elsewhere);
    await settle();
    expect(asked("work.money.receive")).toEqual([]);
    paste(document.querySelector("[data-money-view]")!);
    await settle();
    await settle();
    expect(asked("work.money.receive")).toHaveLength(1);
    elsewhere.remove();
  });
});


