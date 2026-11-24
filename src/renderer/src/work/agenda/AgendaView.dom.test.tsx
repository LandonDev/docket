// @vitest-environment jsdom
/** The Agenda's header: in a narrow Week or Month view, the period stays in TempCode's own header, short. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

const { Head, shortMonth, shortWeek } = await import("./AgendaView");

afterEach(cleanup);

describe("the Agenda's header", () => {
  it("keeps a short period in the Week and Month views under a 640px header, beside the full period wider", () => {
    const { container } = render(<Head {...({ workspace: { id: "ws" } } as never)} />);
    // The list has no period to name.
    expect(container.querySelector("[data-agenda-short-period]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    const short = container.querySelector("[data-agenda-short-period]")!;
    expect(short.textContent).toBe(shortMonth(Date.now()));
    // Drawn only while the header is narrow, where the full period hides.
    expect(short.className).toContain("@min-[40rem]/viewhead:hidden");
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    const next = new Date();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    expect(container.querySelector("[data-agenda-short-period]")!.textContent).toBe(shortMonth(next.getTime()));
    // The week view keeps a short period too.
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(container.querySelector("[data-agenda-short-period]")!.textContent).toBe(shortWeek(Date.now()));
  });

  it("names a narrow week short: its first and last day, the month once within a month", () => {
    const monday = 1;
    const md = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    // Mon Nov 16 to Sun Nov 22, 2026: one month.
    expect(shortWeek(new Date(2026, 10, 18).getTime(), monday)).toBe(`${md(new Date(2026, 10, 16))} – 22`);
    // Mon Nov 30 to Sun Dec 6: the month named twice.
    expect(shortWeek(new Date(2026, 11, 2).getTime(), monday)).toBe(`${md(new Date(2026, 10, 30))} – ${md(new Date(2026, 11, 6))}`);
  });

  it("names a month short, with its year", () => {
    expect(shortMonth(new Date(2026, 10, 19).getTime())).toBe(new Date(2026, 10, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" }));
  });
});
