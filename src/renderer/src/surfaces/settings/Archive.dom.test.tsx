// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@shared/events";

const state = vi.hoisted(() => ({
  projects: [] as { path: string }[],
  /** What the store knows (the window's own list). */
  metas: [] as Record<string, unknown>[],
  /** What each computer answers `session.list {archived: true}` with: a list, an Error, or null for no answer yet. */
  hosts: {} as Record<string, Record<string, unknown>[] | Error | null>,
  asked: [] as string[],
}));

vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../../lib/recents", () => ({
  loadArchivedProjects: () => state.projects,
  subscribeArchivedProjects: () => () => {},
  looksLikeProject: () => false,
}));
vi.mock("../../lib/tcserver/store", () => ({ useSessionMetas: () => state.metas, sessionStore: { ensureArchived: async () => {} } }));
vi.mock("../../lib/connection", () => ({
  LOCAL_ENVIRONMENT_ID: "local",
  useEnvironments: () => Object.keys(state.hosts).map((id) => ({ id, name: id })),
  registry: {
    linkOf: (id: string) => ({
      request: () => {
        state.asked.push(id);
        const answer = state.hosts[id];
        if (answer === null) return new Promise(() => {});
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer ?? []);
      },
    }),
  },
}));
vi.mock("../../lib/settings/computerName", () => ({
  useComputerNames: () => (id: string) => (id === "local" ? { name: "MacBook-Pro", own: true } : { name: "The box", own: false }),
  computerInLine: (c: { name: string; own: boolean }) => (c.own ? "this Mac" : c.name === "The box" ? "the box" : c.name),
}));
vi.mock("../../lib/tcserver/workspaces", () => ({
  useProjects: () => [
    { id: "p1", name: "Alpha" },
    { id: "p2", name: "Beta" },
  ],
  useWorkspaces: () => [],
  workspaceLabelKey: (_w: unknown, _p: string, fallback: string) => fallback,
}));
vi.mock("../../chrome/RemoveProjectDialog", () => ({
  RemoveProjectDialog: ({ name }: { name: string }) => <div role="dialog">Remove {name}</div>,
}));

const { ArchivePage } = await import("./Archive");

const meta = (id: string, title: string, projectId: string, updatedAt = 1) => ({
  id,
  title,
  projectId,
  provider: "claude",
  archived: true,
  cwd: "/w",
  updatedAt,
});

const handlers = () => ({
  onOpenSession: vi.fn(),
  onArchiveSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onRestoreProject: vi.fn(),
  onDeleteProject: vi.fn(),
});

async function clickDelete(row: HTMLElement, verb = "Delete") {
  await act(async () => {
    fireEvent.click(within(row).getByRole("button", { name: /^More for / }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: `${verb}…` }));
  });
}

const rowOf = (text: string) => screen.getByText(text).closest<HTMLElement>("[data-slot=page-row]")!;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  state.projects = [];
  state.metas = [];
  state.hosts = { local: [] };
  state.asked = [];
});
afterEach(cleanup);

describe("Archive page", () => {
  it("shows an empty state for each list once every computer answered", async () => {
    render(<ArchivePage {...handlers()} />);
    await settle();
    const lines = [...document.querySelectorAll("[data-slot=page-empty]")].map((p) => p.textContent);
    expect(lines).toEqual(["No archived projects", "No archived threads"]);
  });

  it("shows Restore and ⋯ on a row, with Delete… in the menu", async () => {
    state.metas = [meta("t1", "Fix the build", "p1")];
    render(<ArchivePage {...handlers()} />);
    await settle();
    const row = rowOf("Fix the build");
    expect(within(row).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Restore Fix the build",
      "More for Fix the build",
    ]);
    expect(within(row).queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("a row's actions wait on the shared hover reveal and an open menu holds them, never a click", async () => {
    state.metas = [meta("t1", "Fix the build", "p1")];
    render(<ArchivePage {...handlers()} />);
    const wrapper = within(rowOf("Fix the build")).getByRole("button", { name: "Restore Fix the build" }).parentElement!.className;
    expect(wrapper).toContain("group-hover/item:delay-(--delay-hover)");
    expect(wrapper).toContain("has-[[data-popup-open]]:opacity-100");
    expect(wrapper).toContain("group-has-focus-visible/item:opacity-100");
    expect(wrapper).not.toContain("focus-within");
  });

  it("restores a thread and opens it, and the row leaves at once", async () => {
    state.metas = [meta("t1", "Fix the build", "p1")];
    const h = handlers();
    render(<ArchivePage {...h} />);
    await settle();
    await act(async () => {
      fireEvent.click(within(rowOf("Fix the build")).getByRole("button", { name: "Restore Fix the build" }));
    });
    expect(h.onArchiveSession).toHaveBeenCalledWith("t1", false);
    expect(h.onOpenSession).toHaveBeenCalledWith("t1");
    expect(screen.queryByText("Fix the build")).toBeNull();
  });

  it("filters by title and project, and says when nothing matches", async () => {
    state.metas = [meta("t1", "Fix the build", "p1"), meta("t2", "Write docs", "p2")];
    render(<ArchivePage {...handlers()} />);
    const search = screen.getByRole("searchbox", { name: "Search archived threads" });
    fireEvent.change(search, { target: { value: "beta" } });
    expect(screen.queryByText("Fix the build")).toBeNull();
    expect(screen.getByText("Write docs")).toBeTruthy();
    fireEvent.change(search, { target: { value: "fix" } });
    expect(screen.getByText("Fix the build")).toBeTruthy();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No archived thread matches")).toBeTruthy();
  });

  it("shows the next hundred on Show more", async () => {
    state.metas = Array.from({ length: 150 }, (_, i) => meta(`t${i}`, `Thread ${i}`, "p1", 1000 - i));
    render(<ArchivePage {...handlers()} />);
    expect(screen.getAllByRole("button", { name: /^Restore / })).toHaveLength(100);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    });
    expect(screen.getAllByRole("button", { name: /^Restore / })).toHaveLength(150);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("deletes a thread only from its confirm", async () => {
    state.metas = [meta("t1", "Fix the build", "p1")];
    const h = handlers();
    render(<ArchivePage {...h} />);
    await clickDelete(rowOf("Fix the build"));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Delete Fix the build?");
    expect(h.onDeleteSession).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Delete thread" }));
    });
    expect(h.onDeleteSession).toHaveBeenCalledWith("t1", { confirmed: true });
    // The thread menu's own confirm: its verb and line, drawn once in the app.
    expect(confirm.textContent).toContain("Its transcript is gone for good.");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("opens the remove dialog for a project's Remove…", async () => {
    state.projects = [{ path: "/w/old" }];
    render(<ArchivePage {...handlers()} />);
    await clickDelete(rowOf("old"), "Remove");
    expect(screen.getByRole("dialog").textContent).toBe("Remove old");
  });

  it("has no switch: the sidebar's shelf keeps its own state", async () => {
    render(<ArchivePage {...handlers()} />);
    await settle();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("Archive asks each computer itself", () => {
  it("lists a computer's archived threads the window never loaded, each naming its computer", async () => {
    state.hosts = { local: [meta("t1", "Fix the build", "p1", 2)], env_box: [{ ...meta("t2", "Venue for the spring LAN", "p2", 1) }] };
    render(<ArchivePage {...handlers()} />);
    await settle();
    expect(state.asked.sort()).toEqual(["env_box", "local"]);
    expect(rowOf("Fix the build").textContent).toContain("Alpha, on this Mac");
    expect(rowOf("Venue for the spring LAN").textContent).toContain("Beta, on the box");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search archived threads" }), { target: { value: "venue" } });
    expect(screen.queryByText("Fix the build")).toBeNull();
    expect(screen.getByText("Venue for the spring LAN")).toBeTruthy();
  });

  it("holds the list's shape while a computer answers, never saying there are none", async () => {
    state.hosts = { local: [], env_box: null };
    render(<ArchivePage {...handlers()} />);
    await settle();
    expect(screen.queryByText("No archived threads")).toBeNull();
    expect(document.querySelectorAll("[data-slot=page-row-skeleton]").length).toBeGreaterThan(0);
  });

  it("says which computer did not answer with Retry, and still lists the others' threads", async () => {
    state.hosts = { local: [meta("t1", "Fix the build", "p1")], env_box: new Error("not connected") };
    render(<ArchivePage {...handlers()} />);
    await settle();
    expect(screen.getByText("Fix the build")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("The box did not send its archived threads. Not connected.");
    state.hosts.env_box = [meta("t2", "Venue for the spring LAN", "p2")];
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await settle();
    expect(screen.getByText("Venue for the spring LAN")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops a thread restored in another window", async () => {
    state.hosts = { local: [meta("t1", "Fix the build", "p1")] };
    state.metas = [{ ...meta("t1", "Fix the build", "p1"), archived: false }];
    render(<ArchivePage {...handlers()} />);
    await settle();
    expect(screen.queryByText("Fix the build")).toBeNull();
  });
});
