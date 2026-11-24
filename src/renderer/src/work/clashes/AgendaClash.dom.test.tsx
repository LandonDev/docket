// @vitest-environment jsdom
/** A clash on its event's Agenda row: the line in that event's words, its press, Show clash, and Leave from the rule. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeosRange } from "@shared/work/clashes";

const HOUR = 3_600_000;
// A fixed morning, and the clock held on it: the events below stand two to five hours ahead, and a run late in the
// evening carried the meeting over midnight, where the list draws it on both of its days and every row was found twice.
const now = new Date(2026, 10, 23, 9, 0).getTime();
const lifeos = vi.hoisted(() => ({ asked: [] as { name: string; args: unknown }[], range: null as unknown, ready: true }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: (environmentId: string, sector: string | null) => ({ environmentId, sector, client: {}, state: "connected" }),
  useLifeosQuery: (session: { sector: string | null }, name: string, args: unknown) => {
    lifeos.asked.push({ name, args });
    if (name !== "clashes:range") return { status: "loading" };
    // A clash is read as him, never through the view's own job.
    if (session.sector !== null) throw new Error("clashes read through a job's session");
    return lifeos.ready ? { status: "ready", value: lifeos.range } : { status: "loading" };
  },
}));
vi.mock("convex/react", async (original) => ({ ...(await original<object>()), ConvexProvider: ({ children }: { children: unknown }) => children }));
const events = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../tasks/client", async (original) => ({ ...(await original<object>()), viewsClients: () => ({ agenda: { useEvents: () => events.rows } }) }));

const drawn = vi.hoisted(() => ({ marked: [] as string[][] }));
vi.mock("work-kit/views", async (original) => ({
  ...(await original<object>()),
  AgendaWeek: ({ marked }: { marked?: ReadonlySet<string> }) => (drawn.marked.push([...(marked ?? [])]), (<div data-week="" />)),
  AgendaMonth: ({ marked }: { marked?: ReadonlySet<string> }) => (drawn.marked.push([...(marked ?? [])]), (<div data-month="" />)),
}));

const { Head, View } = await import("../agenda/AgendaView");
const { clashAsk } = await import("./open");
const { clockOf } = await import("@shared/work/clashes");

beforeEach(() => void vi.useFakeTimers({ now, toFake: ["Date"] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  clashAsk.set(null);
  lifeos.asked.length = 0;
  lifeos.ready = true;
});

const props = { env: "box", workspace: { id: "ws", environmentId: "box" }, sector: "purdue", lifeos: { client: {}, state: "connected" }, startThread: () => {} } as never;
const meeting = { _id: "ev_meeting", title: "Staff meeting", sector: "purdue", startsAt: now + 2 * HOUR, endsAt: now + 4 * HOUR, allDay: false, location: "Cedar Hall" };
const side = (eventId: string, sector: string, title: string, startsAt: number, endsAt: number) => ({ eventId, sector, title, startsAt, endsAt, can: [] });
const game = side("ev_game", "ref", "Varsity Basketball", now + 3 * HOUR, now + 5 * HOUR);
const overlap: LifeosRange = {
  clashes: [{ id: "ev_meeting-ev_game", kind: "overlap", a: side("ev_meeting", "purdue", "Staff meeting", meeting.startsAt, meeting.endsAt) as never, b: game as never }],
  leaves: [],
};

describe("a clash on the Agenda row", () => {
  it("says the clash under the place in the event's own words, in the colour that says he is needed", async () => {
    events.rows = [meeting];
    lifeos.range = overlap;
    render(<View {...props} />);
    await act(async () => {});
    const line = screen.getByRole("button", { name: `Overlaps Varsity Basketball (Ref), ${clockOf(game.startsAt)}` });
    expect(line.className).toContain("text-warning");
    expect(line.className).toContain("text-xs");
    // Under the place, in the row's own column.
    expect(line.previousElementSibling?.textContent).toBe("Cedar Hall");
    // The same span the list shows, every job's.
    const asked = lifeos.asked.find((a) => a.name === "clashes:range")!.args as { from: number; to: number };
    expect(asked.to - asked.from).toBe(14 * 24 * HOUR);
  });

  it("opens the Clash dialog on a press, and from the row's menu", async () => {
    events.rows = [meeting];
    lifeos.range = overlap;
    render(<View {...props} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^Overlaps/ }));
    expect(clashAsk.get()).toMatchObject({ id: "ev_meeting-ev_game", environmentId: "box", clash: { kind: "overlap" } });
    clashAsk.set(null);
    fireEvent.contextMenu(screen.getByRole("listitem"));
    await act(async () => {});
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show clash" }));
    expect(clashAsk.get()?.id).toBe("ev_meeting-ev_game");
  });

  it("says each of several on a line of its own, and names each in the menu by the other event, so every one can be opened", async () => {
    events.rows = [meeting];
    lifeos.range = {
      clashes: [...overlap.clashes, { ...overlap.clashes[0]!, id: "ev_meeting-ev_other", b: side("ev_other", "life", "Dentist", now + 3 * HOUR, now + 4 * HOUR) as never }],
      leaves: [],
    };
    render(<View {...props} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: `Overlaps Varsity Basketball (Ref), ${clockOf(game.startsAt)}` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Overlaps Dentist \(Life\)/ }));
    expect(clashAsk.get()?.id).toBe("ev_meeting-ev_other");
    fireEvent.contextMenu(screen.getByRole("listitem"));
    await act(async () => {});
    expect(screen.queryByRole("menuitem", { name: "Show clash" })).toBeNull();
    expect(await screen.findByRole("menuitem", { name: "Show clash with Dentist" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Show clash with Varsity Basketball" }));
    expect(clashAsk.get()?.id).toBe("ev_meeting-ev_game");
  });

  it("tells two clashes with events of one name apart in the menu, by job and time", async () => {
    events.rows = [meeting];
    const twin = side("ev_twin", "life", game.title, now + 3 * HOUR, now + 4 * HOUR);
    lifeos.range = { clashes: [...overlap.clashes, { ...overlap.clashes[0]!, id: "ev_meeting-ev_twin", b: twin as never }], leaves: [] };
    render(<View {...props} />);
    await act(async () => {});
    fireEvent.contextMenu(screen.getByRole("listitem"));
    await act(async () => {});
    expect(await screen.findByRole("menuitem", { name: `Show clash with ${game.title} (Ref, ${clockOf(game.startsAt)})` })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: `Show clash with ${game.title} (Life, ${clockOf(twin.startsAt)})` }));
    expect(clashAsk.get()?.id).toBe("ev_meeting-ev_twin");
  });

  it("gives a same-name clash on another day its weekday in the menu, as the row's line does", async () => {
    events.rows = [meeting];
    const next = side("ev_next", "ref", game.title, game.startsAt + 24 * HOUR, game.endsAt + 24 * HOUR);
    lifeos.range = { clashes: [...overlap.clashes, { ...overlap.clashes[0]!, id: "ev_meeting-ev_next", b: next as never }], leaves: [] };
    render(<View {...props} />);
    await act(async () => {});
    fireEvent.contextMenu(screen.getByRole("listitem"));
    await act(async () => {});
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(next.startsAt);
    expect(await screen.findByRole("menuitem", { name: `Show clash with ${game.title} (Ref, ${clockOf(game.startsAt)})` })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: `Show clash with ${game.title} (Ref, ${weekday} ${clockOf(next.startsAt)})` }));
    expect(clashAsk.get()?.id).toBe("ev_meeting-ev_next");
  });

  it("draws no line and no menu row for an event with no clash, or one that is over", async () => {
    const over = { ...meeting, _id: "ev_over", startsAt: now - 3 * HOUR, endsAt: now - HOUR };
    events.rows = [over, { ...meeting, _id: "ev_free" }];
    lifeos.range = { clashes: [{ ...overlap.clashes[0]!, id: "ev_over-ev_game", a: { ...overlap.clashes[0]!.a, eventId: "ev_over", startsAt: over.startsAt, endsAt: over.endsAt } }], leaves: [] };
    render(<View {...props} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /^Overlaps/ })).toBeNull();
    fireEvent.contextMenu(screen.getAllByRole("listitem")[1]!);
    await act(async () => {});
    expect(screen.queryByRole("menuitem", { name: "Show clash" })).toBeNull();
  });

  it("drops a clash once its later event is over, from the row, its menu and the Week's dot, though this event still runs", async () => {
    const running = { ...meeting, startsAt: now - 5 * HOUR, endsAt: now + 2 * HOUR };
    events.rows = [running];
    const done = side("ev_done", "ref", "Stand-up", now - 4 * HOUR, now - 3 * HOUR);
    lifeos.range = { clashes: [{ ...overlap.clashes[0]!, id: "ev_meeting-ev_done", b: done as never }], leaves: [] };
    render(<View {...props} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /^Overlaps/ })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("listitem"));
    await act(async () => {});
    expect(screen.getByRole("menuitem", { name: "Prepare" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /^Show clash/ })).toBeNull();
    cleanup();
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    await act(async () => {});
    expect(drawn.marked.at(-1)).toEqual([]);
  });

  it("keeps a clash on the later event's row, its menu and the Week's dot after the earlier event ends: that is when he is running late", async () => {
    events.rows = [meeting];
    const left = side("ev_left", "ref", "Varsity Basketball", now - 3 * HOUR, now - 60_000);
    lifeos.range = { clashes: [{ id: "ev_left-ev_meeting", kind: "drive", a: left as never, b: overlap.clashes[0]!.a, minutes: 44, measured: true, shortBy: 14 }], leaves: [] };
    render(<View {...props} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "14 min short after Varsity Basketball (Ref)" })).toBeTruthy();
    fireEvent.contextMenu(screen.getByRole("listitem"));
    await act(async () => {});
    expect(screen.getByRole("menuitem", { name: "Show clash" })).toBeTruthy();
    cleanup();
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    await act(async () => {});
    expect(drawn.marked.at(-1)).toEqual(["ev_meeting"]);
  });

  it("keeps the line, the menu row and the dot of an event with no end for the hour LifeOS runs it, though the list greys it at its start", async () => {
    // A check-in with no end began a quarter hour ago: the Agenda reads its start as its end, LifeOS runs it an hour.
    const checkIn = { ...meeting, startsAt: now - 15 * 60_000, endsAt: undefined };
    events.rows = [checkIn];
    const side0 = { ...overlap.clashes[0]!.a, startsAt: checkIn.startsAt, endsAt: checkIn.startsAt + HOUR };
    lifeos.range = { clashes: [{ ...overlap.clashes[0]!, a: side0, b: { ...game, startsAt: now - 5 * 60_000, endsAt: now + HOUR } as never }], leaves: [] };
    render(<View {...props} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: /^Overlaps Varsity Basketball \(Ref\)/ })).toBeTruthy();
    fireEvent.contextMenu(screen.getByRole("listitem"));
    await act(async () => {});
    expect(screen.getByRole("menuitem", { name: "Show clash" })).toBeTruthy();
    cleanup();
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    await act(async () => {});
    expect(drawn.marked.at(-1)).toEqual(["ev_meeting"]);
  });

  it("lets a clash go at the very minute its later event ends, as the dialog calls that event over", async () => {
    // The clock stands on the minute the game ends; the meeting runs on.
    const end = Math.ceil(now / 60_000) * 60_000 + 30 * 60_000;
    vi.setSystemTime(end);
    try {
      events.rows = [{ ...meeting, startsAt: end - 2 * HOUR, endsAt: end + HOUR }];
      const ended = side("ev_game", "ref", "Varsity Basketball", end - HOUR, end);
      lifeos.range = { clashes: [{ ...overlap.clashes[0]!, a: { ...overlap.clashes[0]!.a, startsAt: end - 2 * HOUR, endsAt: end + HOUR }, b: ended as never }], leaves: [] };
      render(
        <>
          <Head {...props} />
          <View {...props} />
        </>,
      );
      await act(async () => {});
      expect(screen.queryByRole("button", { name: /^Overlaps/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Week" }));
      await act(async () => {});
      expect(drawn.marked.at(-1)).toEqual([]);
    } finally {
      vi.setSystemTime(now);
    }
  });

  it("hands the Week and the Month the events that clash, for their dot", async () => {
    events.rows = [meeting];
    lifeos.range = overlap;
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await act(async () => {});
    for (const view of ["Week", "Month"]) {
      drawn.marked.length = 0;
      fireEvent.click(screen.getByRole("button", { name: view }));
      await act(async () => {});
      // Only this view's own events, by their ids: the game is another job's.
      expect(drawn.marked.at(-1)).toEqual(["ev_meeting"]);
    }
  });

  it("marks no event that is over in the Week or the Month, as the list drops its line", async () => {
    events.rows = [{ ...meeting, startsAt: now - 3 * HOUR, endsAt: now - HOUR }];
    lifeos.range = { clashes: [{ ...overlap.clashes[0]!, a: { ...overlap.clashes[0]!.a, startsAt: now - 3 * HOUR, endsAt: now - HOUR } }], leaves: [] };
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    await act(async () => {});
    expect(drawn.marked.at(-1)).toEqual([]);
  });

  it("takes Leave from the rule once it has answered, and LifeOS's own until then", async () => {
    const leaveAt = meeting.startsAt - 50 * 60_000;
    events.rows = [{ ...meeting, leaveAt: meeting.startsAt - 20 * 60_000 }];
    lifeos.ready = false;
    const view = render(<View {...props} />);
    await act(async () => {});
    const first = screen.getByText(/^Leave /).textContent;
    lifeos.ready = true;
    lifeos.range = { clashes: [], leaves: [{ eventId: "ev_meeting", leaveAt, minutes: 20, measured: true, from: "event", fromTitle: "Lunch" }] };
    view.rerender(<View {...props} />);
    await act(async () => {});
    const second = screen.getByText(/^Leave /).textContent;
    expect(second).not.toBe(first);
    // No leave in the rule's answer: nothing is drawn, whatever the event row held.
    lifeos.range = { clashes: [], leaves: [] };
    view.rerender(<View {...props} />);
    await act(async () => {});
    expect(screen.queryByText(/^Leave /)).toBeNull();
  });
});
