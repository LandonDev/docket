// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatsPreview } from "../stats.preview";
import fixtures from "../stats.fixtures";

class SeenObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(): void {
    this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  disconnect(): void {}
}
beforeEach(() => vi.stubGlobal("IntersectionObserver", SeenObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const idle = fixtures.find((f) => f.name === "An idle week and two idle days")!;

describe("a day chart's axis", () => {
  it("gives an idle week its week of room: Daily output's bars stand one slot a calendar day apart", () => {
    const { container } = render(<StatsPreview {...idle.props} />);
    const claude = [...container.querySelectorAll('[aria-label="Daily output"] path[name="Claude Code"]')].map((p) => Number(p.getAttribute("x")));
    // 21 days with work, of 30: Oct 11 to Oct 19 is eight slots, as far as eight working days are.
    expect(claude).toHaveLength(21);
    const slot = claude[1]! - claude[0]!;
    expect(claude[11]! - claude[10]!).toBeCloseTo(8 * slot, 1);
  });

  it("leaves a gap in Cache hit rate where no rate exists, with a dot for a day alone between two gaps", () => {
    const { container } = render(<StatsPreview {...idle.props} />);
    const cache = container.querySelector('[aria-label="Cache hit rate"]')!;
    // Oct 1–11, Oct 19 alone, Oct 22–30: two runs of line (the lone day's move draws no length), and its dot.
    const runs = cache.querySelector(".recharts-line-curve")!.getAttribute("d")!.split("M").filter(Boolean);
    expect(runs).toHaveLength(3);
    expect(runs.filter((r) => /[CL]/.test(r))).toHaveLength(2);
    expect(cache.querySelectorAll("[data-lone-dot]")).toHaveLength(1);
  });
});
