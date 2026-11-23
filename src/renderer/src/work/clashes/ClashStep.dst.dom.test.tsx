// @vitest-environment jsdom
/** A way out's step on the day the clocks go forward: a time he types into the hour they skip is refused at its field, and nothing goes. */
// The zone is set before any date of the test is read; vitest runs each file in its own process (pool: forks).
process.env.TZ = "America/New_York";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Clash, ClashSide } from "@shared/work/clashes";

const { StepForm } = await import("./ClashDialog");

// 2027-03-14 in New York: 2:00 to 2:59 AM never shows.
const at = (hour: number, minute = 0) => new Date(2027, 2, 14, hour, minute).getTime();
const side = (eventId: string, title: string, startsAt: number, endsAt: number, can: ClashSide["can"]): ClashSide => ({ eventId, sector: "ref", title, startsAt, endsAt, can });
const clash: Clash = { id: "ev_a-ev_b", kind: "overlap", a: side("ev_a", "Film review", at(9), at(11), ["propose"]), b: side("ev_b", "Varsity Basketball", at(10), at(12), []) };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
afterAll(() => {
  delete process.env.TZ;
});

describe("a step on the night the clocks go back", () => {
  it("says which 1:30 AM an event ends at, in its times and under the field", () => {
    // 2026-11-01 in New York: 1:00 to 1:59 AM comes twice. A game from the first 1:30 to the second, and a call that offers it the hour after.
    const first = Date.UTC(2026, 10, 1, 5, 30);
    // The evening before, by the clock the step reads: an offer is never a time already gone.
    vi.useFakeTimers({ now: first - 6 * 3_600_000, toFake: ["Date"] });
    const game = side("ev_a", "Late game", first, first + 3_600_000, ["propose"]);
    const call = side("ev_b", "Call", first - 15 * 60_000, first + 15 * 60_000, []);
    render(<StepForm clash={{ id: "ev_b-ev_a", kind: "overlap", a: call, b: game }} step={{ side: "b", way: "propose" }} pending={false} onBack={() => {}} onSend={() => {}} />);
    expect(screen.getByRole("group", { name: "Late game" }).textContent).toContain("1:30 AM – second 1:30 AM");
    // Offered the quarter hour after the call ends: the first 1:45 AM to the second 1:45.
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("01:45");
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("01:45");
    expect(document.querySelector("[data-clash-step]")?.textContent).toContain("Second 1:45 AM");
  });
});

describe("a step's times on the day the clocks go forward", () => {
  it("marks the field whose time the clocks skip, says so, sends nothing, and lets go of both when he edits", () => {
    expect(new Date(2027, 2, 14, 2, 30).getHours()).toBe(3);
    const onSend = vi.fn();
    render(<StepForm clash={clash} step={{ side: "a", way: "propose" }} pending={false} onBack={() => {}} onSend={onSend} />);
    const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
    fireEvent.change(field("Day"), { target: { value: "2027-03-14" } });
    fireEvent.change(field("From"), { target: { value: "02:30" } });
    fireEvent.change(field("To"), { target: { value: "04:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("alert").textContent).toBe("From is in the hour the clocks skip that day. Pick another time.");
    expect(field("From").getAttribute("aria-invalid")).toBe("true");
    expect(field("To").getAttribute("aria-invalid")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(field("From"), { target: { value: "03:00" } });
    expect(screen.getByRole("alert").textContent).toBe("");
    expect(field("From").getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith({ start: Date.UTC(2027, 2, 14, 7, 0), end: Date.UTC(2027, 2, 14, 8, 0) });
  });
});
