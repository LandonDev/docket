// @vitest-environment jsdom
/** An event's row opens its meeting's page (work/prep): Prepare until the event is over, Follow up after, on the row and in its right-click. Opening starts no thread. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const now = Date.now();
vi.mock("../shell/lifeos", async (original) => ({ ...(await original<object>()), useLifeosQuery: () => ({ status: "loading" }) }));
vi.mock("convex/react", async (original) => ({ ...(await original<object>()), ConvexProvider: ({ children }: { children: unknown }) => children }));
const events = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../tasks/client", async (original) => ({ ...(await original<object>()), viewsClients: () => ({ agenda: { useEvents: () => events.rows } }) }));

const { View } = await import("./AgendaView");
const { agendaPlace, resetAgendaPlace } = await import("./place");
const { openWorkView, workViewNow } = await import("../../lib/workSwitch");

if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

afterEach(() => {
  cleanup();
  openWorkView(null);
});

const started: unknown[] = [];
const props = { env: "box", workspace: { id: "ws", environmentId: "box" }, sector: "purdue", lifeos: { client: {}, state: "connected" }, startThread: (chip: unknown) => void started.push(chip) } as never;
const HOUR = 3_600_000;
// Both today: one that ended an hour ago, one that starts in an hour.
const over = { _id: "ev-over", title: "Staff sync", sector: "purdue", startsAt: now - 2 * HOUR, endsAt: now - HOUR, allDay: false };
const ahead = { _id: "ev-ahead", title: "Budget review", sector: "purdue", startsAt: now + HOUR, endsAt: now + 2 * HOUR, allDay: false };

describe("Agenda's way to a meeting's page", () => {
  it("reads Prepare until the event is over and Follow up after, and either opens the page", async () => {
    events.rows = [over, ahead];
    render(<View {...props} />);
    await act(async () => {});
    const rows = screen.getAllByRole("listitem");
    const verbOf = (title: string) => rows.find((r) => r.textContent?.includes(title))!.querySelector("button")!;
    expect(verbOf("Budget review").textContent).toBe("Prepare");
    expect(verbOf("Staff sync").textContent).toBe("Follow up");

    fireEvent.click(verbOf("Budget review"));
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "prep", event: "ev-ahead" });
    fireEvent.click(verbOf("Staff sync"));
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "prep", event: "ev-over" });
    // Opening the page starts no thread: that is the page's own verb.
    expect(started).toEqual([]);
  });

  it("offers the same verb in the row's right-click", async () => {
    events.rows = [over];
    render(<View {...props} />);
    await act(async () => {});
    await act(async () => fireEvent.contextMenu(screen.getByRole("listitem")));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Follow up" })));
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "prep", event: "ev-over" });
  });

  it("uses the page's own end rule for the verb, so the row and the page never disagree about an event with no end", async () => {
    // Timed, no end, began half an hour ago: Agenda's own rule calls it past at once; the page gives it an hour.
    const running = { _id: "ev-running", title: "Stand-up", sector: "purdue", startsAt: now - HOUR / 2, allDay: false };
    events.rows = [running, over];
    render(<View {...props} />);
    await act(async () => {});
    const rows = screen.getAllByRole("listitem");
    const verbOf = (title: string) => rows.find((r) => r.textContent?.includes(title))!.querySelector("button")!;
    expect(verbOf("Stand-up").textContent).toBe("Prepare");
    expect(verbOf("Staff sync").textContent).toBe("Follow up");
  });

  it("keeps the day and the view he was on through a visit to a meeting's page, and opens on today again after any other leave", async () => {
    events.rows = [ahead];
    const nextWeek = agendaPlace.get().day + 7 * 24 * HOUR;
    let view = render(<View {...props} />);
    await act(async () => {});
    act(() => agendaPlace.set({ view: "list", day: nextWeek, adding: null }));
    // Prepare: the page opens and Agenda unmounts under it
    act(() => openWorkView({ workspaceId: "ws", view: "prep", event: "ev-ahead" }));
    view.unmount();
    expect(agendaPlace.get().day).toBe(nextWeek);
    // Back from the page, then away to another view: the next visit is today's list
    act(() => openWorkView({ workspaceId: "ws", view: "agenda" }));
    view = render(<View {...props} />);
    await act(async () => {});
    act(() => openWorkView({ workspaceId: "ws", view: "tasks" }));
    view.unmount();
    expect(agendaPlace.get().day).not.toBe(nextWeek);
    expect(agendaPlace.get().view).toBe("list");
    resetAgendaPlace();
  });
});
