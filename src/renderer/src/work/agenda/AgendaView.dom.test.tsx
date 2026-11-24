// @vitest-environment jsdom
/** The Agenda's header: in a narrow Week or Month view, the period stays in TempCode's own header, short. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localeWeekStart, viewRange } from "work-kit/views/lib/agenda";
const NOW = new Date(2026, 10, 23, 12);

const { resetAgendaPlace } = await import("./place");
const { Head, Title, View, holdsToday, shortMonth, shortWeek } = await import("./AgendaView");
const { keepPlace } = await import("../shell/place");

beforeEach(() => {
  vi.setSystemTime(NOW);
  localStorage.clear();
  resetAgendaPlace();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Agenda's header", () => {
  it("keeps a short period in the Week and Month views under a 640px header, beside the full period wider", () => {
    const { container } = render(<Head {...({ workspace: { id: "ws" } } as never)} />);
    // The list has no period to name.
    expect(container.querySelector("[data-agenda-short-period]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    const short = container.querySelector("[data-agenda-short-period]")!;
    expect(short.textContent).toBe(shortMonth(NOW.getTime()));
    // Drawn only while the header is narrow, where the full period hides.
    expect(short.className).toContain("@min-[40rem]/viewhead:hidden");
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    const next = new Date(2026, 11, 1);
    expect(container.querySelector("[data-agenda-short-period]")!.textContent).toBe(shortMonth(next.getTime()));
    // The week view keeps a short period too.
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Today" })[0]!);
    expect(container.querySelector("[data-agenda-short-period]")!.textContent).toBe(shortWeek(NOW.getTime()));
  });

  it("keeps a way back to today when narrow: an icon press with its tip, only off today's period", () => {
    const { container } = render(<Head {...({ workspace: { id: "ws" } } as never)} />);
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    // On this week there is nowhere to go back to.
    expect(container.querySelector('[data-agenda-today="icon"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    const icon = container.querySelector<HTMLElement>('[data-agenda-today="icon"]')!;
    // Drawn only where the word gives way.
    expect(icon.className).toContain("@min-[26rem]/viewhead:hidden");
    expect(icon.getAttribute("aria-label")).toBe("Today");
    fireEvent.click(icon);
    expect(container.querySelector("[data-agenda-short-period]")!.textContent).toBe(shortWeek(NOW.getTime()));
    expect(container.querySelector('[data-agenda-today="icon"]')).toBeNull();
  });

  it("offers the way back within the minute its period ends, though nothing else draws the header again", () => {
    // Half a minute before this week's end: the header shows this week, with no Today icon.
    const end = viewRange("week", NOW.getTime(), localeWeekStart()).to;
    vi.useRealTimers();
    vi.useFakeTimers({ now: end - 30_000 });
    const { container } = render(<Head {...({ workspace: { id: "ws" } } as never)} />);
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(container.querySelector('[data-agenda-today="icon"]')).toBeNull();
    // The week turns: the header's own minute tick sees it.
    act(() => void vi.advanceTimersByTime(60_000));
    expect(container.querySelector('[data-agenda-today="icon"]')).not.toBeNull();
  });

  it("knows the period that holds today", () => {
    const monday = 1;
    const now = NOW.getTime();
    expect(holdsToday("week", new Date(2026, 10, 18).getTime(), now, monday)).toBe(false);
    expect(holdsToday("week", new Date(2026, 10, 25).getTime(), now, monday)).toBe(true);
    expect(holdsToday("month", new Date(2026, 10, 2).getTime(), now, monday)).toBe(true);
    expect(holdsToday("month", new Date(2026, 11, 2).getTime(), now, monday)).toBe(false);
  });

  it("lets the view's name give way whole in a narrow Week or Month, never cut to a stub; the List keeps it", () => {
    render(<Head {...({ workspace: { id: "ws" } } as never)} />);
    const { container } = render(<Title {...({ workspace: { id: "ws" } } as never)} />);
    const name = (): HTMLElement => container.querySelector("span")!;
    expect(name().textContent).toBe("Agenda");
    expect(name().className).not.toContain("sr-only");
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(name().className).toContain("@max-[26rem]/viewhead:sr-only");
  });

  it("gives way at narrow widths: Today under 26rem of header, the three views as one select under 40rem", () => {
    const { container } = render(<Head {...({ workspace: { id: "ws" } } as never)} />);
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getAllByRole("button", { name: "Today" })[0]!.className).toContain("@max-[26rem]/viewhead:hidden");
    // The short period is never cut: the view's name gives way before it.
    expect(container.querySelector("[data-agenda-short-period]")!.className).toContain("shrink-0");
    expect(container.querySelector('[data-agenda-views="toggle"]')!.className).toContain("hidden @min-[40rem]/viewhead:flex");
    const select = container.querySelector('[data-agenda-views="select"]')!;
    expect(select.className).toContain("@min-[40rem]/viewhead:hidden");
    // The select names the same choice and shows the view he is on.
    expect(within(select as HTMLElement).getByRole("combobox", { name: "Show as" }).textContent).toBe("Week");
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

describe("the Agenda's bones", () => {
  const view = (show: "list" | "week" | "month") => {
    // The visit opens on the view the workspace kept.
    keepPlace("ws", "agenda", { view: show, day: NOW.getTime(), on: NOW.getTime() });
    const props = { env: "box", workspace: { id: "ws" }, sector: "purdue", lifeos: { environmentId: "box", sector: "purdue", client: null, state: "connecting" } };
    return render(<View {...(props as never)} />).container;
  };

  it("take the shape of the view he kept: the Week's and the Month's grids, the list's rows", () => {
    expect(view("week").querySelector('[data-agenda-bones="week"]')).not.toBeNull();
    cleanup();
    const month = view("month").querySelector('[data-agenda-bones="month"]')!;
    expect(month.querySelectorAll(".grid-rows-6 > div")).toHaveLength(42);
    cleanup();
    expect(view("list").querySelector("[data-agenda-bones]")).toBeNull();
  });
});
