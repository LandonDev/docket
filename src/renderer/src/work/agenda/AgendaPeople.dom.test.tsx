// @vitest-environment jsdom
/** An event's attendees who are the sector's people are named on its List row, and a name opens their page in People. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const now = Date.now();
const lifeos = vi.hoisted(() => ({ asked: [] as unknown[] }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  // The owner session the clash read rides (work/clashes/mark.tsx): none here, so no row carries a clash.
  useLifeosSession: () => ({ environmentId: "box", sector: null, client: null, state: "connecting" }),
  useLifeosQuery: (_session: unknown, name: string, args: unknown) => {
    lifeos.asked.push({ name, args });
    return name === "people:directory"
      ? {
          status: "ready",
          value: [
            { _id: "p_maya", name: "Maya Chen", emails: ["maya@school.edu"] },
            { _id: "p_tom", name: "Tom Beck", emails: ["tom@school.edu"] },
            { _id: "p_ana", name: "Ana Ruiz", emails: ["ana@school.edu"] },
            { _id: "p_lee", name: "Lee Park", emails: ["lee@school.edu"] },
          ],
        }
      : { status: "loading" };
  },
}));
vi.mock("convex/react", async (original) => ({ ...(await original<object>()), ConvexProvider: ({ children }: { children: unknown }) => children }));
const events = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../tasks/client", async (original) => ({ ...(await original<object>()), viewsClients: () => ({ agenda: { useEvents: () => events.rows } }) }));

const { View } = await import("./AgendaView");
const { openWorkView, workViewNow } = await import("../../lib/workSwitch");

afterEach(() => {
  cleanup();
  openWorkView(null);
});

const props = { env: "box", workspace: { id: "ws", environmentId: "box" }, sector: "purdue", lifeos: { client: {}, state: "connected" }, startThread: () => {} } as never;
const event = (attendees: { address: string }[]) => ({ _id: "ev1", title: "Tryouts", sector: "purdue", startsAt: now + 3_600_000, allDay: false, attendees });

describe("Agenda's people", () => {
  it("names the sector's people at an event, three and how many more, and a name opens their page", async () => {
    events.rows = [event([{ address: "MAYA@school.edu" }, { address: "stranger@x.org" }, { address: "tom@school.edu" }, { address: "ana@school.edu" }, { address: "lee@school.edu" }])];
    render(<View {...props} />);
    await act(async () => {});
    expect(lifeos.asked).toContainEqual({ name: "people:directory", args: { sector: "purdue" } });
    expect(screen.getByText(/^With/).textContent).toBe("With Maya Chen, Tom Beck, Ana Ruiz, and 1 more");
    fireEvent.click(screen.getByRole("button", { name: "Tom Beck" }));
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "people", person: "p_tom" });
  });

  it("names no one when no attendee is one of the sector's people", async () => {
    events.rows = [event([{ address: "stranger@x.org" }])];
    render(<View {...props} />);
    await act(async () => {});
    expect(screen.queryByText(/^With/)).toBeNull();
  });
});
