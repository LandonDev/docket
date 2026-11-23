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
  /** suggestion ids LifeOS will not file */
  refuses: [] as string[],
}));
const held = vi.hoisted(() => ({ opened: [] as unknown[] }));
vi.mock("../canvas/held", async (original) => ({ ...(await original<object>()), openHeld: (ref: unknown, env: string) => void held.opened.push({ ref, env }) }));
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
        if (method === "work.prep.brief" || method === "work.prep.followUp") return { sessionId: method === "work.prep.brief" ? "t-brief" : "t-follow" };
        if (method === "work.prep.ahead") return { on: params.on, offered: true };
        if (method === "work.prep.notes") {
          const was = host.page as PrepPage;
          host.page = { ...was, rev: was.rev + 1, doc: { ...was.doc, notes: String(params.text).trim() ? { text: String(params.text).trim(), at: 1 } : null } };
        }
        if (method === "work.prep.decide") {
          const was = host.page as PrepPage;
          const ids = params.taskIds as string[];
          const failed = ids.filter((id) => host.refuses.includes(id)).map((id) => ({ id, error: "LifeOS did not answer" }));
          const state = params.decision === "accept" ? "filed" : "rejected";
          const tasks = was.doc.after!.tasks.map((t) => (ids.includes(t.id) && !host.refuses.includes(t.id) ? { ...t, state, ...(state === "filed" ? { lifeosTaskId: `task-${t.id}` } : {}) } : t));
          host.page = { ...was, rev: was.rev + 1, doc: { ...was.doc, after: { ...was.doc.after!, tasks } } };
          return { page: host.page, failed };
        }
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
const { workOpenPort } = await import("../../lib/workSwitch");
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
  host.refuses = [];
  held.opened = [];
  lifeos.asked = [];
  localStorage.clear();
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

// ── The brief (P2), prepare ahead (P3) and after the meeting (P4) ──

const head = () => within(screen.getByTestId("head"));
const push = (p: Record<string, unknown>) => act(async () => host.pushes.forEach((fn) => fn(p)));
const menuRows = async (): Promise<HTMLElement[]> => {
  await act(async () => fireEvent.click(head().getByRole("button", { name: "More" })));
  const menu = await screen.findByRole("menu");
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
};
const more = async (item: string) => {
  const row = (await menuRows()).find((r) => r.textContent === item);
  if (!row) throw new Error(`More has no “${item}”`);
  await act(async () => fireEvent.click(row));
};
const moreRows = async (): Promise<string[]> => {
  const rows = (await menuRows()).map((r) => r.textContent ?? "");
  await act(async () => fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" }));
  return rows;
};
const BRIEF = { matters: [{ text: "Maya needs the seat list by Wednesday.", ref: { table: "mailThreads" as const, id: "m1" } }, { text: "Tom declined; someone else carries the venue form." }], agreed: [], files: [], at: 5, by: "t-brief" };
const briefed = (over: Partial<PrepPage> = {}) => facts({ doc: { ...emptyPrepDoc(), brief: BRIEF }, rev: 2, state: "briefed", briefSessionId: "t-brief", ...over });

describe("Brief me", () => {
  it("starts the thread on the host and stays on the page, which says Preparing where the brief will be", async () => {
    const opened: string[] = [];
    workOpenPort.set((id) => void opened.push(id));
    await mount();
    expect(screen.queryByLabelText("The brief is being written")).toBeNull();
    host.page = facts({ rev: 1, state: "working", briefSessionId: "t-brief" });
    await act(async () => fireEvent.click(head().getByRole("button", { name: "Brief me" })));
    expect(host.asked.map((a) => a.method)).toEqual(["work.prep.page", "work.prep.brief", "work.prep.page"]);
    // still the page: no thread was opened for him
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "prep", event: "ev1" });
    expect(opened).toEqual([]);
    expect(head().queryByRole("button", { name: "Brief me" })).toBeNull();
    expect(screen.getByLabelText("The brief is being written")).toBeTruthy();
    // Preparing opens the thread
    fireEvent.click(head().getByRole("button", { name: "Preparing" }));
    expect(opened).toEqual(["t-brief"]);
    workOpenPort.set(null);
  });

  it("draws the brief when the thread writes it: body text with no heading, a line with a reference pressable", async () => {
    host.page = facts({ rev: 1, state: "working", briefSessionId: "t-brief" });
    await mount();
    host.page = briefed();
    await push({ push: "work.prep", workspaceId: "ws", eventId: "ev1", rev: 2 });
    const brief = within(screen.getByRole("region", { name: "What matters" }));
    expect(screen.queryByLabelText("The brief is being written")).toBeNull();
    expect(brief.queryByRole("heading")).toBeNull();
    expect(brief.getByText("Tom declined; someone else carries the venue form.").tagName).toBe("P");
    // lines that land on an open page rise in a step apart; a page opened with its brief does not replay it
    expect(brief.getByText("Tom declined; someone else carries the venue form.").parentElement!.className).toBe("step-land");
    fireEvent.click(brief.getByRole("button", { name: "Maya needs the seat list by Wednesday." }));
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "mail", mail: "m1" });
    // once briefed the header holds no verb; More holds Prepare again and Open thread
    await act(async () => openWorkView({ workspaceId: "ws", view: "prep", event: "ev1" }));
    expect(head().getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["More"]);
    expect(await moreRows()).toEqual(["Open thread", "Prepare again", "Add people…", "Add notes…", "New thread about this", "Prepare each morning"]);
    cleanup();
    resetPrep();
    await mount();
    expect(screen.getByText("Tom declined; someone else carries the venue form.").parentElement!.className).toBe("");
  });

  it("offers Brief me again when its thread stopped without writing", async () => {
    // the host's bound on time has run out: the page is back to facts, with the thread still named
    host.page = facts({ rev: 1, state: "none", briefSessionId: "t-brief" });
    await mount();
    expect(head().getByRole("button", { name: "Brief me" })).toBeTruthy();
    await more("Prepare each morning");
  });

  it("says why when the host does not start the thread", async () => {
    await mount();
    host.fails = "Work is off on this host";
    await act(async () => fireEvent.click(head().getByRole("button", { name: "Brief me" })));
    await act(async () => {});
    expect(head().getByRole("button", { name: "Brief me" })).toBeTruthy();
  });
});

describe("Prepare ahead", () => {
  it("is offered once under his first brief, and Turn on makes the routine in this window's time zone", async () => {
    host.page = briefed();
    await mount();
    const offer = () => document.querySelector("[data-prep-offer]");
    expect(offer()?.textContent).toContain("Prepare each morning’s meetings ahead");
    await act(async () => fireEvent.click(within(offer() as HTMLElement).getByRole("button", { name: "Turn on" })));
    expect(host.asked.find((a) => a.method === "work.prep.ahead")!.params).toEqual({ workspaceId: "ws", on: true, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    expect(offer()).toBeNull();
    // never again in this workspace, whatever the page says next time
    cleanup();
    resetPrep();
    await mount();
    expect(offer()).toBeNull();
  });

  it("is dismissed for good, and is never drawn for a sector it is withheld from or once it is on", async () => {
    host.page = briefed();
    await mount();
    await act(async () => fireEvent.click(within(document.querySelector("[data-prep-offer]") as HTMLElement).getByRole("button", { name: "Dismiss" })));
    expect(document.querySelector("[data-prep-offer]")).toBeNull();
    expect(host.asked.some((a) => a.method === "work.prep.ahead")).toBe(false);

    for (const page of [briefed({ aheadOffered: false }), briefed({ aheadOn: true })]) {
      cleanup();
      resetPrep();
      localStorage.clear();
      host.page = page;
      await mount();
      expect(document.querySelector("[data-prep-offer]")).toBeNull();
    }
    // Purdue's More has no check row either
    cleanup();
    resetPrep();
    host.page = briefed({ aheadOffered: false });
    await mount();
    expect(await moreRows()).not.toContain("Prepare each morning");
  });

  it("is a check row in More that turns the routine on and off", async () => {
    host.page = briefed({ aheadOn: true });
    await mount();
    await more("Prepare each morning");
    expect(host.asked.find((a) => a.method === "work.prep.ahead")!.params).toMatchObject({ workspaceId: "ws", on: false });
  });
});

const OVER = at(16);
const outcome = (over: Partial<PrepPage> = {}) =>
  facts({
    rev: 5,
    state: "after",
    briefSessionId: "t-brief",
    followSessionId: "t-follow",
    doc: {
      ...emptyPrepDoc(),
      brief: BRIEF,
      notes: { text: "Seat list to Maya Wed.\nDana drives the van.", at: 9 },
      after: {
        summary: [{ text: "The van is settled." }],
        decisions: [{ text: "Dana drives the van" }],
        questions: [{ text: "When the form is signed" }],
        tasks: [
          { id: "s1", title: "Send Maya the seat list", due: at(9, 0, 25), state: "proposed" },
          { id: "s2", title: "Confirm jersey sizes", who: "Tom Beck", state: "proposed" },
          { id: "s3", title: "Old idea", state: "rejected" },
        ],
        at: 10,
      },
    },
    drafts: [{ outboxId: "ob1", subject: "Staff sync follow-up", to: ["Maya Chen", "Tom Beck"] }],
    ...over,
  });

describe("after the meeting", () => {
  beforeEach(() => vi.setSystemTime(OVER));

  it("offers Add notes once it is over, then Follow up once notes stand", async () => {
    await mount();
    expect(head().getByRole("button", { name: "Add notes" })).toBeTruthy();
    // the header holds it, so More does not say it twice
    expect(await moreRows()).toEqual(["Add people…", "New thread about this", "Prepare each morning"]);
    await act(async () => fireEvent.click(head().getByRole("button", { name: "Add notes" })));
    const dialog = within(await screen.findByRole("dialog", { name: "Notes" }));
    expect((dialog.getByRole("button", { name: "Follow up" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText("Notes"), { target: { value: "Dana drives the van." } });
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Follow up" })));
    expect(host.asked.slice(1).map((a) => [a.method, a.params.text])).toEqual([["work.prep.notes", "Dana drives the van."], ["work.prep.followUp", undefined], ["work.prep.page", undefined]]);
  });

  it("keeps what he typed when the dialog is closed any other way, and starts nothing", async () => {
    await mount();
    await act(async () => fireEvent.click(head().getByRole("button", { name: "Add notes" })));
    const dialog = within(await screen.findByRole("dialog", { name: "Notes" }));
    fireEvent.change(dialog.getByLabelText("Notes"), { target: { value: "Half a thought" } });
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Cancel" })));
    await vi.waitFor(() => expect(host.asked.some((a) => a.method === "work.prep.notes" && a.params.text === "Half a thought")).toBe(true));
    expect(host.asked.some((a) => a.method === "work.prep.followUp")).toBe(false);
    // the header's verb is Follow up now, and the notes are on the page
    await vi.waitFor(() => expect(head().getByRole("button", { name: "Follow up" })).toBeTruthy());
    expect(within(screen.getByRole("region", { name: "Notes" })).getByText("Half a thought")).toBeTruthy();
    await act(async () => fireEvent.click(head().getByRole("button", { name: "Follow up" })));
    expect(host.asked.at(-2)!.method).toBe("work.prep.followUp");
  });

  it("leads with the outcome: the summary, his notes, what was decided, the tasks, the open questions and the mail, then the rest as it was", async () => {
    host.page = outcome();
    await mount();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Notes", "Decided", "To do", "Open questions", "Mail", "Brief", "Last time, Nov 16", "People", "Tasks", "Files"]);
    expect(screen.getByText("The van is settled.")).toBeTruthy();
    // a rejected suggestion is gone; who and when are one muted line
    expect(rowsOf("To do")).toEqual(["Send Maya the seat listdue Wed, Nov 25", "Confirm jersey sizesTom Beck"]);
    expect(rowsOf("Mail")).toEqual(["Follow-up to Maya Chen and Tom BeckWaiting for your press"]);
    // an outcome stands: the header holds no verb
    expect(head().getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["More"]);
  });

  it("starts suggested tasks unticked, counts the ticks on the one button, and files only what he ticked", async () => {
    host.page = outcome();
    await mount();
    const todo = () => section("To do");
    expect(todo().getAllByRole("checkbox").map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect(todo().queryByRole("button", { name: /^Add/ })).toBeNull();
    fireEvent.click(todo().getByRole("checkbox", { name: "Send Maya the seat list" }));
    expect(todo().getByRole("button", { name: "Add 1 task" })).toBeTruthy();
    fireEvent.click(todo().getByRole("button", { name: "Tick all" }));
    expect(todo().getByRole("button", { name: "Add 2 tasks" })).toBeTruthy();
    fireEvent.click(todo().getByRole("button", { name: "Untick all" }));
    expect(todo().queryByRole("button", { name: /^Add/ })).toBeNull();
    // the whole row takes the pointer
    fireEvent.click(todo().getByText("Confirm jersey sizes"));
    await act(async () => fireEvent.click(todo().getByRole("button", { name: "Add 1 task" })));
    expect(host.asked.at(-1)).toEqual({ method: "work.prep.decide", params: { workspaceId: "ws", eventId: "ev1", taskIds: ["s2"], decision: "accept" } });
    // filed: no tick, and the row opens the task's sheet
    const rows = todo().getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-task-state"))).toEqual(["proposed", "filed"]);
    expect(todo().getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(todo().getByRole("button", { name: /Confirm jersey sizes/ }));
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "tasks", task: "task-s2" });
  });

  it("says a filing that failed in one line, keeps it ticked-able, and tries again on Retry", async () => {
    host.page = outcome();
    host.refuses = ["s1"];
    await mount();
    fireEvent.click(section("To do").getByRole("button", { name: "Tick all" }));
    await act(async () => fireEvent.click(section("To do").getByRole("button", { name: "Add 2 tasks" })));
    expect(screen.getByRole("status").textContent).toContain("A task was not added");
    expect(screen.getByRole("status").textContent).toContain("LifeOS did not answer");
    expect(section("To do").getAllByRole("listitem").map((r) => r.getAttribute("data-task-state"))).toEqual(["proposed", "filed"]);
    host.refuses = [];
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(host.asked.at(-1)!.params).toMatchObject({ taskIds: ["s1"], decision: "accept" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses the rest from More, and the mail row opens the Outbox on its draft and sends nothing", async () => {
    host.page = outcome();
    await mount();
    await more("Dismiss the rest");
    expect(host.asked.at(-1)!.params).toMatchObject({ taskIds: ["s1", "s2"], decision: "reject" });
    expect(screen.queryByRole("region", { name: "To do" })).toBeNull();
    fireEvent.click(section("Mail").getByRole("button", { name: /Follow-up to Maya Chen and Tom Beck/ }));
    expect(held.opened).toEqual([{ ref: { at: "lifeos", table: "outbox", id: "ob1" }, env: "box" }]);
    // every call the page made is one of prep's own: nothing sends
    expect([...new Set(host.asked.map((a) => a.method))].sort()).toEqual(["work.prep.decide", "work.prep.page"]);
  });

  it("folds long notes to six lines until Show all", async () => {
    host.page = outcome({ doc: { ...outcome().doc, notes: { text: Array.from({ length: 9 }, (_, i) => `Line ${i + 1}`).join("\n"), at: 9 } } });
    await mount();
    const notes = section("Notes");
    expect(notes.getByText(/Line 1/).className).toContain("line-clamp-6");
    fireEvent.click(notes.getByRole("button", { name: "Show all" }));
    expect(notes.getByText(/Line 1/).className).not.toContain("line-clamp-6");
  });
});
