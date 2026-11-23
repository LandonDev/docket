// @vitest-environment jsdom
/**
 * A meeting's page (docs/agents/work-prep.md): the facts the host read from LifeOS, each row
 * opening where its thing lives, the ways back and out in its header, and Add people. The host
 * and LifeOS stand in; the people are dummies.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPrepDoc, type PrepPage } from "@shared/contract-work-prep";
import type { ContextChip } from "@shared/work";
import { openWorkView, workViewNow } from "../../lib/workSwitch";
import type { WorkViewProps } from "../views/registry";

if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

const at = (hour: number, minute = 0, day = 23): number => new Date(2026, 10, day, hour, minute).getTime();
const NOW = at(9, 30);

const host = vi.hoisted(() => ({
  asked: [] as { method: string; params: Record<string, unknown> }[],
  page: null as unknown,
  fails: null as string | null,
  pushes: [] as ((push: Record<string, unknown>) => void)[],
}));
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      onPush: (fn: (push: Record<string, unknown>) => void) => {
        host.pushes.push(fn);
        return () => void host.pushes.splice(host.pushes.indexOf(fn), 1);
      },
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ method, params });
        if (host.fails) throw new Error(host.fails);
        if (method === "work.prep.people") host.page = { ...(host.page as PrepPage), rev: (host.page as PrepPage).rev + 1, doc: { ...emptyPrepDoc(), people: params.people } };
        return { page: await host.page };
      },
    }),
  },
}));
const lifeos = vi.hoisted(() => ({ asked: [] as { name: string; args: Record<string, unknown> }[] }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosQuery: (_session: unknown, name: string, args: Record<string, unknown>) => {
    lifeos.asked.push({ name, args });
    if (name === "mail:faces") return { status: "ready", value: [] };
    if (name === "people:directory")
      return {
        status: "ready",
        value: [
          { _id: "p1", name: "Maya Chen", emails: ["maya@x.test"] },
          { _id: "p3", name: "Dana Reyes", emails: ["dana@x.test"] },
          { _id: "p4", name: "Sam Whitaker", emails: ["sam@x.test"] },
        ],
      };
    return { status: "loading" };
  },
}));

const { View, Head, Title, PrepPageBody } = await import("./PrepView");
const { resetPrep } = await import("./data");
// The dialogs are a chunk of their own: here before the first press, as a hover would have it.
await import("./PrepDialogs");

const facts = (over: Partial<PrepPage> = {}): PrepPage => ({
  workspaceId: "ws",
  sector: "purdue",
  event: { id: "ev1", title: "Staff sync", startsAt: at(14), endsAt: at(14, 45), allDay: false, location: "RecWell 204", leaveAt: at(13, 40) },
  people: [
    { name: "Maya Chen", address: "maya@x.test", personId: "p1", mail: { id: "m1", subject: "Bracket for Friday", at: at(7, 30), unread: true } },
    { name: "Tom Beck", address: "tom@x.test", personId: "p2", declined: true },
    { name: "Outside Person", address: "out@elsewhere.test" },
  ],
  morePeople: 2,
  tasks: [
    { id: "t1", title: "Send the seat list", dueAt: at(9, 0, 25), why: "asked", who: "Maya Chen" },
    { id: "t2", title: "Staff handbook update" },
  ],
  files: [{ title: "Join", url: "https://school.zoom.us/j/1" }],
  last: { eventId: "ev0", title: "Staff sync", startsAt: at(14, 0, 16), decided: [{ text: "Scrims move to Thursdays" }], open: [{ text: "Who drives the van", ref: { table: "mailThreads", id: "m9" } }], tasks: [{ id: "t9", title: "Order jerseys" }] },
  doc: emptyPrepDoc(),
  rev: 0,
  state: "none",
  briefSessionId: null,
  followSessionId: null,
  drafts: [],
  aheadOn: false,
  aheadOffered: true,
  problems: [],
  ...over,
});

let started: ContextChip[];
const props = (): WorkViewProps =>
  ({ env: "box", workspace: { id: "ws", environmentId: "box" }, sector: "purdue", lifeos: { client: {}, state: "connected" }, startThread: (c: ContextChip) => void started.push(c) }) as never;
const mount = async () => {
  openWorkView({ workspaceId: "ws", view: "prep", event: "ev1" });
  const view = render(
    <>
      <div data-testid="title">
        <Title {...props()} />
      </div>
      <div data-testid="head">
        <Head {...props()} />
      </div>
      <View {...props()} />
    </>,
  );
  await act(async () => {});
  return view;
};
const section = (name: string) => within(screen.getByRole("region", { name }));
const rowsOf = (name: string) => section(name).getAllByRole("listitem").map((r) => r.textContent);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  started = [];
  host.asked = [];
  host.fails = null;
  host.page = facts();
  host.pushes = [];
  lifeos.asked = [];
  resetPrep();
});
afterEach(() => {
  cleanup();
  openWorkView(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the page of facts", () => {
  it("reads the meeting from the workspace's host and says when, where and when to leave", async () => {
    await mount();
    expect(host.asked).toEqual([{ method: "work.prep.page", params: { workspaceId: "ws", eventId: "ev1" } }]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Staff sync");
    expect(screen.getByText("Today, 2:00 to 2:45 PM, RecWell 204, leave 1:40")).toBeTruthy();
  });

  it("draws each section that has something, in the page's order, and none that has nothing", async () => {
    await mount();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Last time, Nov 16", "People", "Tasks", "Files"]);
    expect(rowsOf("People")).toEqual(["MCMaya ChenBracket for Friday7:30 AM", "TBTom BeckDeclined", "OPOutside Person"]);
    expect(section("People").getByText("and 2 more")).toBeTruthy();
    expect(rowsOf("Tasks")).toEqual(["Send the seat listAsked by Maya ChenWed", "Staff handbook update"]);
    expect(rowsOf("Files")).toEqual(["Joinschool.zoom.us"]);
    expect(rowsOf("Last time, Nov 16")).toEqual(["Scrims move to Thursdays", "Who drives the vanLeft open", "Order jerseysStill to do"]);

    cleanup();
    resetPrep();
    host.page = facts({ tasks: [], files: [], last: null, morePeople: 0 });
    await mount();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["People"]);
  });

  it("opens each row where its thing lives", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    await mount();
    // Each press leaves the page for where the thing lives; the page is opened again for the next.
    const press = async (region: string, name: RegExp) => {
      await act(async () => openWorkView({ workspaceId: "ws", view: "prep", event: "ev1" }));
      fireEvent.click(section(region).getByRole("button", { name }));
    };
    // a person: their newest mail, or their page in People when there is none
    await press("People", /Maya Chen/);
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "mail", mail: "m1" });
    await press("People", /Tom Beck/);
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "people", person: "p2" });
    await press("Tasks", /Send the seat list/);
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "tasks", task: "t1" });
    await press("Files", /Join/);
    expect(opened).toHaveBeenCalledWith("https://school.zoom.us/j/1", "_blank", "noopener,noreferrer");
    // last time: a line with a reference opens it, a line without one is plain words, and the label opens that page
    await press("Last time, Nov 16", /Who drives the van/);
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "mail", mail: "m9" });
    await act(async () => openWorkView({ workspaceId: "ws", view: "prep", event: "ev1" }));
    // someone who is not one of the sector's people opens nothing
    expect(section("People").queryByRole("button", { name: /Outside Person/ })).toBeNull();
    expect(section("Last time, Nov 16").queryByRole("button", { name: /Scrims move/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Last time, Nov 16" }));
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "prep", event: "ev0" });
  });

  it("moves between its rows with the arrow keys", async () => {
    await mount();
    const maya = section("People").getByRole("button", { name: /Maya Chen/ });
    maya.focus();
    fireEvent.keyDown(maya, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Tom Beck");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(maya);
  });
});

describe("a page with no one on it", () => {
  it("says so in one line and offers Add people", async () => {
    host.page = facts({ people: [], morePeople: 0, tasks: [], files: [], last: null });
    await mount();
    expect(section("People").getByText("No one is listed on this event")).toBeTruthy();
    await act(async () => fireEvent.click(section("People").getByRole("button", { name: "Add people" })));
    expect(await screen.findByRole("dialog", { name: "Add people" })).toBeTruthy();
  });
});

describe("what does not load", () => {
  it("shows bones while the page is read, in the page's place", async () => {
    let land: (v: unknown) => void = () => {};
    host.page = new Promise((resolve) => (land = resolve));
    openWorkView({ workspaceId: "ws", view: "prep", event: "ev1" });
    const { container } = render(<View {...props()} />);
    expect(container.querySelector("[aria-busy]")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    land(null);
  });

  it("names a part that failed in one line with Retry, and keeps the rest", async () => {
    host.page = facts({ tasks: [], problems: ["tasks"] });
    await mount();
    expect(screen.getByRole("status").textContent).toContain("Tasks did not load");
    expect(rowsOf("People")).toHaveLength(3);
    host.page = facts();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(host.asked.filter((a) => a.method === "work.prep.page")).toHaveLength(2);
    expect(screen.queryByRole("status")).toBeNull();
    expect(rowsOf("Tasks")).toHaveLength(2);
  });

  it("says the whole page did not load in the host's words, with Retry", async () => {
    host.fails = "That event is not in Purdue’s sector.";
    await mount();
    expect(screen.getByText("This page did not load")).toBeTruthy();
    expect(screen.getByText("That event is not in Purdue’s sector.")).toBeTruthy();
    host.fails = null;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Staff sync");
  });

  it("reads the page again when the host says its rev moved, and not for another meeting's push", async () => {
    await mount();
    const push = (p: Record<string, unknown>) => act(async () => host.pushes.forEach((fn) => fn(p)));
    await push({ push: "work.prep", workspaceId: "ws", eventId: "other", rev: 5 });
    await push({ push: "work.prep", workspaceId: "ws", eventId: "ev1", rev: 0 });
    expect(host.asked).toHaveLength(1);
    host.page = facts({ rev: 1, event: { ...facts().event, title: "Staff sync, moved" } });
    await push({ push: "work.prep", workspaceId: "ws", eventId: "ev1", rev: 1 });
    expect(host.asked).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Staff sync, moved");
  });
});

describe("a dialog left open", () => {
  it("is closed when the page goes, so the next meeting's page never opens under it", async () => {
    const view = await mount();
    await act(async () => fireEvent.click(within(screen.getByTestId("head")).getByRole("button", { name: "More" })));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Add people…" })));
    expect(await screen.findByRole("dialog", { name: "Add people" })).toBeTruthy();
    view.unmount();
    await mount();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the header", () => {
  it("leads back to Agenda and names the meeting", async () => {
    await mount();
    expect(screen.getByTestId("title").textContent).toBe("AgendaStaff sync");
    fireEvent.click(screen.getByRole("button", { name: "Back to Agenda" }));
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "agenda" });
  });

  it("keeps New thread about this and Add people in More", async () => {
    await mount();
    await act(async () => fireEvent.click(within(screen.getByTestId("head")).getByRole("button", { name: "More" })));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "New thread about this" })));
    expect(started).toEqual([{ kind: "event", label: "Staff sync", ref: { at: "lifeos", table: "events", id: "ev1" } }]);
    await act(async () => fireEvent.click(within(screen.getByTestId("head")).getByRole("button", { name: "More" })));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Add people…" })));
    expect(await screen.findByRole("dialog", { name: "Add people" })).toBeTruthy();
  });
});

describe("Add people", () => {
  const open = async () => {
    await mount();
    await act(async () => fireEvent.click(within(screen.getByTestId("head")).getByRole("button", { name: "More" })));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Add people…" })));
    return within(await screen.findByRole("dialog", { name: "Add people" }));
  };

  it("lists the sector's people who are not on the event, searches them, and keeps the ticked with the page", async () => {
    const dialog = await open();
    expect(lifeos.asked).toContainEqual({ name: "people:directory", args: { sector: "purdue" } });
    // Maya is on the event itself
    expect(dialog.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["Dana Reyes", "Sam Whitaker"]);
    fireEvent.change(dialog.getByLabelText("Search people"), { target: { value: "sam" } });
    expect(dialog.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["Sam Whitaker"]);
    fireEvent.click(dialog.getByRole("checkbox", { name: "Sam Whitaker" }));
    fireEvent.change(dialog.getByLabelText("Search people"), { target: { value: "" } });
    expect(dialog.getByRole("checkbox", { name: "Sam Whitaker" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Save" })));
    expect(host.asked.at(-1)).toEqual({ method: "work.prep.people", params: { workspaceId: "ws", eventId: "ev1", people: [{ name: "Sam Whitaker", address: "sam@x.test", personId: "p4" }] } });
  });

  it("adds someone LifeOS does not know by the name he typed, and unticks one added before", async () => {
    host.page = facts({ doc: { ...emptyPrepDoc(), people: [{ name: "Dana Reyes", address: "dana@x.test", personId: "p3" }] } });
    const dialog = await open();
    expect(dialog.getByRole("checkbox", { name: "Dana Reyes" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(dialog.getByRole("checkbox", { name: "Dana Reyes" }));
    fireEvent.change(dialog.getByLabelText("Search people"), { target: { value: "Priya Raman" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add “Priya Raman” by name" }));
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Save" })));
    expect(host.asked.at(-1)!.params.people).toEqual([{ name: "Priya Raman" }]);
  });

  it("says why when the host refuses, and keeps the dialog open", async () => {
    const dialog = await open();
    host.fails = "only the owner changes a meeting’s page";
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Save" })));
    expect(dialog.getByText("Only the owner changes a meeting’s page")).toBeTruthy();
  });
});

describe("the body alone", () => {
  it("draws from a page and holds no query, so the preview shows what the app shows", () => {
    render(<PrepPageBody page={facts()} faces={new Map()} now={NOW} onRetry={() => {}} onAddPeople={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Staff sync");
    expect(host.asked).toEqual([]);
  });
});
