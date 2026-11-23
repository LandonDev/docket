// @vitest-environment jsdom
/**
 * Mileage and pay from the calendar: a whole offer is added on one press
 * with its own values, an estimate is reviewed first and says so, Add all
 * takes every whole offer, Skip drops one, a trip typed by hand can start
 * from one of the job's events, and the mileage rate is saved for the
 * period's year.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarOffer, MoneyRead } from "@shared/contract-work-money";
import type { Period } from "@shared/work/money";

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
const toast = Object.assign(vi.fn(), { error: vi.fn() });
vi.mock("../../components/ui/toaster", async (original) => ({ ...(await original<object>()), loadToast: async () => toast }));

const { Head, View, setMoneyPeriod } = await import("./MoneyView");
const { readOf } = await import("./money.fixtures");

const props = { env: "box", workspace: { id: "ws", environmentId: "box", name: "Refereeing", kind: "work", sector: "ref" }, sector: "ref", lifeos: {}, startThread: () => {} } as never;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const asked = (method: string) => host.asked.filter((a) => a.method === method).map((a) => a.params);
const offer = (eventId: string, over: Partial<CalendarOffer> = {}): CalendarOffer => ({ eventId, date: "2026-11-21", title: "Varsity at Harrison", place: "Harrison HS", fee: 7500, miles: 24, measured: true, ...over });

function mount() {
  return render(
    <>
      <Head {...props} />
      <View {...props} />
    </>,
  );
}

beforeEach(() => {
  host.asked.length = 0;
  host.read = (p) => readOf(p);
  host.answer = (method) => (method === "work.money.trip" ? { pay: { ok: true, ref: "r", row: 50 }, trip: { row: 3, ref: "m", value: 1680 } } : method === "work.money.events" ? { events: [offer("e9", { title: "JV at Millbrook", date: "2026-11-14", fee: null, miles: 31 })] } : null);
  toast.mockClear();
  setMoneyPeriod({ span: "month", year: 2026, month: 11 });
});
afterEach(cleanup);

describe("trips and pay from the calendar", () => {
  it("adds a whole offer with its own values, and offers Review for an estimate", async () => {
    host.read = (p) => readOf(p, undefined, { calendar: [offer("e1"), offer("e2", { title: "Freshman at Oak Ridge", miles: 40, measured: false })] });
    mount();
    await settle();
    const row = document.querySelector("[data-calendar-offer=e1]") as HTMLElement;
    expect(row.textContent).toContain("Sat Nov 21");
    expect([...row.querySelectorAll("[data-slot=facts] > span")].map((f) => f.textContent)).toEqual(["$75", "24 mi"]);
    expect(row.textContent).not.toContain("·");
    expect(within(document.querySelector("[data-calendar-offer=e2]") as HTMLElement).getByRole("button", { name: "Review Freshman at Oak Ridge" })).toBeTruthy();
    // One whole offer: no Add all.
    expect(screen.queryByRole("button", { name: "Add all" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Add Varsity at Harrison" }));
    await settle();
    expect(asked("work.money.trip")).toEqual([{ workspaceId: "ws", eventId: "e1", date: "2026-11-21", title: "Varsity at Harrison", place: "Harrison HS", miles: 24, fee: 7500 }]);
  });

  it("adds every whole offer with Add all", async () => {
    host.read = (p) => readOf(p, undefined, { calendar: [offer("e1"), offer("e2", { title: "JV at Millbrook" }), offer("e3", { fee: null, title: "Scrimmage" })] });
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add all" }));
    await settle();
    await settle();
    expect(asked("work.money.trip").map((p) => p.eventId)).toEqual(["e1", "e2"]);
  });

  it("skips an offer from its row's menu", async () => {
    host.read = (p) => readOf(p, undefined, { calendar: [offer("e1")] });
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "More for Varsity at Harrison" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Skip" }));
    await settle();
    expect(asked("work.money.skip")).toEqual([{ workspaceId: "ws", eventId: "e1" }]);
  });

  it("reviews an estimate, says it is one, and adds what he settles on", async () => {
    host.read = (p) => readOf(p, undefined, { calendar: [offer("e2", { title: "Freshman at Oak Ridge", miles: 40, measured: false })] });
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Review Freshman at Oak Ridge" }));
    const dialog = await screen.findByRole("dialog", { name: "Trip" });
    expect(within(dialog).getByText("Estimated: check the miles")).toBeTruthy();
    const miles = within(dialog).getByLabelText("Miles there and back") as HTMLInputElement;
    expect(miles.value).toBe("40");
    fireEvent.change(miles, { target: { value: "36" } });
    expect(within(dialog).queryByText("Estimated: check the miles")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await settle();
    expect(asked("work.money.trip")).toEqual([{ workspaceId: "ws", eventId: "e2", date: "2026-11-21", title: "Freshman at Oak Ridge", place: "Harrison HS", miles: 36, fee: 7500 }]);
  });

  it("types a trip by hand, starting from one of the job's events", async () => {
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Trip…" }));
    const dialog = await screen.findByRole("dialog", { name: "Trip" });
    await settle();
    expect(asked("work.money.events")).toEqual([{ workspaceId: "ws" }]);
    fireEvent.click(within(dialog).getByRole("combobox", { name: "From the calendar" }));
    const pick = await screen.findByRole("option", { name: "Sat Nov 14, JV at Millbrook" });
    await act(async () => {
      fireEvent.pointerDown(pick, { pointerType: "mouse" });
      fireEvent.click(pick);
    });
    await settle();
    expect((within(dialog).getByLabelText("Trip") as HTMLInputElement).value).toBe("JV at Millbrook");
    expect((within(dialog).getByLabelText("Miles there and back") as HTMLInputElement).value).toBe("31");
    fireEvent.change(within(dialog).getByLabelText("Fee"), { target: { value: "60" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await settle();
    expect(asked("work.money.trip")).toEqual([{ workspaceId: "ws", eventId: "e9", date: "2026-11-14", title: "JV at Millbrook", place: "Harrison HS", miles: 31, fee: 6000 }]);
  });

  it("saves the mileage rate for the period's year", async () => {
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mileage rate…" }));
    const dialog = await screen.findByRole("dialog", { name: "Mileage rate" });
    expect(within(dialog).getByText("2026")).toBeTruthy();
    expect(within(dialog).getByText("Used for every later year until you set that year's.")).toBeTruthy();
    const rate = within(dialog).getByLabelText("Dollars a mile") as HTMLInputElement;
    expect(rate.value).toBe("0.7");
    fireEvent.change(rate, { target: { value: "0.725" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    expect(asked("work.money.rate")).toEqual([{ workspaceId: "ws", year: 2026, rate: 0.725 }]);
  });
});
