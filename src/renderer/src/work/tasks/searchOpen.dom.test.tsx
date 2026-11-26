// @vitest-environment jsdom
/**
 * A task chosen in Work Search opens its sheet in Tasks, through the view as the app mounts it and Search's own
 * opener (council round 13: Sol Tasks 1, The rest 1):
 * - the same open task chosen twice opens its sheet twice;
 * - a done task, which the open list does not hold, is read by its id and its sheet only reads, "Done" at its foot.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "@shared/work/search";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { WorkViewProps } from "../views/registry";

const lifeos = vi.hoisted(() => ({
  open: [
    { _id: "t1", title: "Book the ballroom", sector: "purdue", status: "todo" },
    { _id: "t2", title: "Send Dana the budget", sector: "purdue", status: "todo" },
  ],
  byId: {
    t1: { _id: "t1", title: "Book the ballroom", sector: "purdue", status: "todo" },
    t2: { _id: "t2", title: "Send Dana the budget", sector: "purdue", status: "todo", description: "The fall numbers" },
    d1: { _id: "d1", title: "Print the brackets", sector: "purdue", status: "done", description: "Forty copies" },
  } as Record<string, unknown>,
}));

// LifeOS as the view's session reads it: the open list, the projects, a task by id; no thread links.
vi.mock("convex/react", async (original) => ({
  ...(await original<object>()),
  ConvexProvider: ({ children }: { children: React.ReactNode }) => children,
  useConvex: () => ({ watchQuery: () => ({ localQueryResult: () => [], onUpdate: () => () => undefined }), mutation: async () => null }),
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: { id?: string }) => {
    const name = getFunctionName(ref);
    if (name === "tasks:list") return lifeos.open;
    if (name === "projects:list") return [];
    if (name === "tasks:get") return args.id && lifeos.byId[args.id] ? { task: lifeos.byId[args.id] } : null;
    return undefined;
  },
}));

const { View } = await import("./TasksView");
const { openHit } = await import("../search/open");
const { openWorkView } = await import("../../lib/workSwitch");

const workspace = { id: "ws", environmentId: "box", path: "/w", name: "Dummy Esports", kind: "work", sector: "purdue" } as unknown as WorkspaceMeta;
const props = { env: "box", workspace, sector: "purdue", lifeos: { client: {} }, startThread: () => undefined } as unknown as WorkViewProps;
const hit = (id: string, title: string): SearchHit => ({ key: `lifeos:tasks:${id}`, kind: "task", title, workspaceId: "ws", open: { to: "view", view: "tasks", with: { task: id } } }) as SearchHit;
// Return on a hit, the window already in the job.
const choose = (h: SearchHit) => act(async () => void (await openHit(h, "box", { workspace: () => workspace, selected: () => ["ws"], clear: () => undefined, chose: () => undefined, opened: () => undefined })));
const sheet = (): HTMLElement | null => screen.queryByRole("dialog");
const close = async (): Promise<void> => {
  fireEvent.keyDown(sheet()!, { key: "Escape" });
  await waitFor(() => expect(sheet()).toBeNull());
};

afterEach(() => {
  cleanup();
  openWorkView(null);
  localStorage.clear();
});

describe("a task chosen in Work Search", () => {
  it("opens its sheet each time it is chosen, the same open task twice", async () => {
    openWorkView({ workspaceId: "ws", view: "tasks" });
    render(<View {...props} />);
    await screen.findByText("Book the ballroom");
    await choose(hit("t2", "Send Dana the budget"));
    expect(within(await screen.findByRole("dialog")).getByText("The fall numbers")).toBeTruthy();
    await close();
    await choose(hit("t2", "Send Dana the budget"));
    const again = await screen.findByRole("dialog");
    expect(within(again).getByText("The fall numbers")).toBeTruthy();
    expect(within(again).getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("reads a done task by its id and opens its sheet with nothing to do, its state a fact at its foot", async () => {
    openWorkView({ workspaceId: "ws", view: "tasks" });
    render(<View {...props} />);
    await screen.findByText("Book the ballroom");
    await choose(hit("d1", "Print the brackets"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Print the brackets")).toBeTruthy();
    expect(within(dialog).getByText("Forty copies")).toBeTruthy();
    // LifeOS kept no done time for it: the fact without a day, never a lone "Done" that reads as a press turned off.
    expect(dialog.querySelector("[data-task-closed]")?.textContent).toBe("Marked done");
    expect(within(dialog).queryByRole("button", { name: "Start thread" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Done" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Open a code thread…" })).toBeNull();
    // The open list keeps its own rows: the done task is not among them.
    expect(screen.getAllByText("Print the brackets")).toHaveLength(1);
    await close();
    // Chosen again, it opens again.
    await choose(hit("d1", "Print the brackets"));
    expect(within(await screen.findByRole("dialog")).getByText("Forty copies")).toBeTruthy();
  });

  it("opens a done task's sheet over Nothing open too, and closes quietly on a task gone since", async () => {
    const was = lifeos.open;
    lifeos.open = [];
    try {
      openWorkView({ workspaceId: "ws", view: "tasks" });
      render(<View {...props} />);
      await screen.findByText("Nothing open");
      await choose(hit("d1", "Print the brackets"));
      expect(within(await screen.findByRole("dialog")).getByText("Forty copies")).toBeTruthy();
      await close();
      await choose(hit("gone", "A task gone since"));
      await act(async () => {});
      expect(sheet()).toBeNull();
    } finally {
      lifeos.open = was;
    }
  });
});
