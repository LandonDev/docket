// @vitest-environment jsdom
/**
 * A return to Money paints the period's last read in its first commit (perf M15), busy until the live read lands,
 * which then takes its place; a host whose Work is off keeps nothing.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoneyRead } from "@shared/contract-work-money";
import type { Period } from "@shared/work/money";

const host = vi.hoisted(() => ({ waiting: [] as Array<{ period: Period; answer: (read: MoneyRead) => void }>, asked: 0 }));
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      onPush: () => () => {},
      onOpen: () => () => {},
      request: (method: string, params: Record<string, unknown>) => {
        if (method !== "work.money.read") return Promise.resolve(null);
        host.asked++;
        // Answered only when the test says: the first commit is drawn with no answer in hand.
        return new Promise<MoneyRead>((resolve) => host.waiting.push({ period: { from: params.from as string, to: params.to as string } as Period, answer: resolve }));
      },
    }),
  },
}));

const { View, setMoneyPeriod } = await import("./MoneyView");
const { moneyKeptCount, resetMoneyKept, MONEY_KEPT } = await import("./api");
const { ALL_ROWS, readOf } = await import("./money.fixtures");
const { setWorkOn, workSwitch } = await import("../../lib/workSwitch");
const { KeptRegion, useKeptRegion } = await import("../shell/lifeos");

const props = { env: "box", workspace: { id: "ws", environmentId: "box", name: "Refereeing", kind: "work", sector: "ref" }, sector: "ref", lifeos: {}, startThread: () => {} } as never;

/** The view inside a region as the view frame draws it (WorkViewPage): `aria-busy` while a kept answer is shown. */
function Framed() {
  const kept = useKeptRegion();
  return (
    <div data-region aria-busy={kept.busy || undefined}>
      <KeptRegion value={kept.scope}>
        <View {...props} />
      </KeptRegion>
    </div>
  );
}

const region = (): HTMLElement => document.querySelector("[data-region]")!;
const answerAll = async (rows = ALL_ROWS): Promise<void> => {
  await act(async () => {
    for (const w of host.waiting.splice(0)) w.answer(readOf(w.period, rows));
  });
};

beforeEach(() => {
  workSwitch.reset();
  setWorkOn("box", true);
  resetMoneyKept();
  host.waiting.length = 0;
  host.asked = 0;
  setMoneyPeriod({ span: "month", year: 2026, month: 11 });
});
afterEach(cleanup);

describe("Money shown again", () => {
  it("paints the period's last read in its first commit, with nothing answered, busy until the live read lands", async () => {
    const first = render(<Framed />);
    await answerAll();
    expect(document.querySelector("[data-money-figures]")!.textContent).toContain("Owed to you");
    first.unmount();
    const asked = host.asked;
    render(<Framed />);
    // The first commit: the kept figures, the region busy, the live read asked and not answered.
    expect(document.querySelector("[data-money-figures]")!.textContent).toContain("Owed to you");
    expect(region().getAttribute("aria-busy")).toBe("true");
    expect(host.asked).toBe(asked + 1);
    expect(host.waiting).toHaveLength(1);
    // Paid elsewhere while he was away: the live read shows it in place, and the region is no longer busy.
    await answerAll(ALL_ROWS.map((r) => ({ ...r, status: "Paid" as const })));
    expect(document.querySelector("[data-money-figures]")!.textContent).not.toContain("Owed to you");
    expect(region().getAttribute("aria-busy")).toBeNull();
  });

  it("keeps nothing of a host whose Work is off", async () => {
    const first = render(<Framed />);
    await answerAll();
    first.unmount();
    expect(moneyKeptCount()).toBe(1);
    act(() => setWorkOn("box", false));
    expect(moneyKeptCount()).toBe(0);
    setWorkOn("box", true);
    render(<Framed />);
    expect(document.querySelector("[data-money-figures]")).toBeNull();
    expect(screen.getByLabelText("Loading money")).toBeTruthy();
  });

  it(`keeps the last ${MONEY_KEPT} periods read, the least recently used dropped`, async () => {
    for (let m = 1; m <= MONEY_KEPT + 2; m++) {
      setMoneyPeriod({ span: "month", year: 2025 + Math.floor((m - 1) / 12), month: ((m - 1) % 12) + 1 });
      const view = render(<Framed />);
      await answerAll();
      view.unmount();
    }
    expect(moneyKeptCount()).toBe(MONEY_KEPT);
  });
});
