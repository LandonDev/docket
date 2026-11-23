// @vitest-environment jsdom
/** An invitation's Open in Agenda: the view opens on the Week its event falls in, whatever month that is, then lets go of the ask. */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// An event two months on, as LifeOS's `events:get` gives it.
const lifeos = vi.hoisted(() => ({ startsAt: new Date(2027, 1, 10, 15, 0).getTime(), asked: [] as unknown[], loading: false, drawn: [] as number[] }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosQuery: (_session: unknown, name: string, args: unknown) => {
    lifeos.asked.push({ name, args });
    return lifeos.loading ? { status: "loading" } : { status: "ready", value: { startsAt: lifeos.startsAt } };
  },
}));
vi.mock("convex/react", async (original) => ({ ...(await original<object>()), ConvexProvider: ({ children }: { children: unknown }) => children }));
vi.mock("../tasks/client", async (original) => ({ ...(await original<object>()), viewsClients: () => ({ agenda: { useEvents: (from: number) => (lifeos.drawn.push(from), []) } }) }));
vi.mock("work-kit/views", async (original) => ({ ...(await original<object>()), AgendaWeek: () => <div data-week="" />, AgendaMonth: () => <div data-month="" /> }));

const { Head, View, shortWeek } = await import("./AgendaView");
const { openWorkView, workViewNow } = await import("../../lib/workSwitch");

afterEach(() => {
  lifeos.loading = false;
  lifeos.drawn.length = 0;
  cleanup();
  openWorkView(null);
});

describe("an invitation's Open in Agenda", () => {
  it("opens Week at the event's day in another month, and clears the ask", async () => {
    openWorkView({ workspaceId: "ws", view: "agenda", event: "ev_1" });
    const props = { env: "box", workspace: { id: "ws", environmentId: "box" }, sector: "purdue", lifeos: { client: {}, state: "connected" }, startThread: () => {} } as never;
    const { container } = render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await act(async () => {});
    expect(lifeos.asked).toContainEqual({ name: "events:get", args: { id: "ev_1" } });
    expect(container.querySelector("[data-week]")).not.toBeNull();
    expect(container.querySelector("[data-agenda-short-period]")!.textContent).toBe(shortWeek(lifeos.startsAt));
    // Taken once: the view's own presses lead from here.
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "agenda" });
  });

  it("draws its bones while the event is read, so today's list never paints before the event's week", async () => {
    lifeos.loading = true;
    openWorkView({ workspaceId: "ws", view: "agenda", event: "ev_1" });
    const props = { env: "box", workspace: { id: "ws", environmentId: "box" }, sector: "purdue", lifeos: { client: {}, state: "connected" }, startThread: () => {} } as never;
    const view = render(<View {...props} />);
    await act(async () => {});
    // Nothing of the agenda drew, not even its read of a range: only the bones.
    expect(lifeos.drawn).toEqual([]);
    expect(view.container.querySelector("[data-week]")).toBeNull();
    expect(view.container.querySelector("[aria-hidden] [data-slot=skeleton], [aria-hidden] .animate-pulse")).not.toBeNull();
    lifeos.loading = false;
    view.rerender(<View {...props} />);
    await act(async () => {});
    expect(view.container.querySelector("[data-week]")).not.toBeNull();
    // The first range it ever read is the event's week, never today's list.
    const start = new Date(lifeos.startsAt);
    expect(lifeos.drawn.length).toBeGreaterThan(0);
    for (const from of lifeos.drawn) expect(Math.abs(from - start.getTime())).toBeLessThan(8 * 24 * 3600 * 1000);
  });
});
