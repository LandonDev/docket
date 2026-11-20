// @vitest-environment jsdom
/** The Agenda's header: in a narrow Month view, the month and year stay in TempCode's own header, short. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

const { Head, shortMonth } = await import("./AgendaView");

afterEach(cleanup);

describe("the Agenda's header", () => {
  it("keeps a short month and year in the Month view under a 640px header, beside the full period wider", () => {
    const { container } = render(<Head {...({} as never)} />);
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
    // The week view keeps its period for the wide header alone, as before.
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(container.querySelector("[data-agenda-short-period]")).toBeNull();
  });

  it("names a month short, with its year", () => {
    expect(shortMonth(new Date(2026, 10, 19).getTime())).toBe(new Date(2026, 10, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" }));
  });
});
