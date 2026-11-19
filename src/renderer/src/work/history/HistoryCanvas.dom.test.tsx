// @vitest-environment jsdom
/**
 * The history canvas in the real pane (docs/agents/work-history.md): a host
 * that answers `work.canvas.list` and `work.history.*` with diffs the real
 * block diff makes, the kind's chunk loaded through the registry, and the
 * frame's stepper fed by a branch's review.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffBlocks, type BlockLike } from "work-kit/formats/diff";
import type { HistoryVersion } from "@shared/contract-work-history";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import { canvasItem, fakeHost } from "../canvas/testkit";

const p = (id: string, text: string, type = "paragraph"): BlockLike => ({ id, type, props: type === "heading" ? { level: 2 } : {}, content: [{ type: "text", text, styles: {} }], children: [] });
const table = (who: string): BlockLike => ({
  id: "t",
  type: "table",
  props: {},
  content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "Role", styles: {} }], [{ type: "text", text: "Who", styles: {} }]] }, { cells: [[{ type: "text", text: "Stage", styles: {} }], [{ type: "text", text: who, styles: {} }]] }] },
  children: [],
});
const OLD = [p("h", "Morning", "heading"), p("a", "8:00 AM Setup crew at the loading dock", "bulletListItem"), p("b", "9:00 AM Doors open"), table("Alex Kim")];
const NEW = [p("h", "Morning", "heading"), p("a", "7:30 AM Setup crew at the loading dock", "bulletListItem"), p("n", "8:30 AM Check-in opens", "bulletListItem"), p("b", "9:00 AM Doors open"), table("Sam Ortiz")];
const AGENT = "agent:env_box:t1";
const VERSIONS: HistoryVersion[] = [
  { id: "v2", at: Date.now() - 60_000, cause: "agent-turn", by: [AGENT], kept: "snapshot" },
  { id: "v1", at: Date.now() - 3_600_000, cause: "named", label: "Wrote the morning", by: ["owner"], kept: "snapshot" },
];

const host = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("../canvas/testkit").fakeHost> | null,
  pushes: new Set<(push: never) => void>(),
  opens: new Set<() => void>(),
  calls: [] as { method: string; params: Record<string, unknown> }[],
  branches: [] as unknown[],
  restore: { mode: "direct" } as Record<string, unknown>,
  failBranches: false,
  failRestore: false,
  failVersions: false,
  toasts: [] as string[],
}));
vi.mock("../../components/ui/toaster", () => ({
  loadToast: async () => Object.assign((m: string) => void host.toasts.push(m), { error: (m: string) => void host.toasts.push(`error: ${m}`) }),
}));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      if (!method.startsWith("work.history.")) return host.current!.link.request(method, params);
      host.calls.push({ method, params });
      const names = { owner: "You", "agent:env_box:t1": "Venue for the spring LAN" };
      if (method === "work.history.versions") {
        if (host.failVersions) throw new Error("The box did not answer");
        return { versions: VERSIONS, shared: false, names };
      }
      if (method === "work.history.compare") {
        const diff = diffBlocks(OLD, NEW);
        for (const row of diff.rows) row.by = [AGENT];
        return { diff, names };
      }
      if (method === "work.history.branches") {
        if (host.failBranches) throw new Error("The box did not answer");
        return { branches: host.branches, names };
      }
      if (method === "work.history.restore") {
        if (host.failRestore) throw new Error("That version is gone");
        return host.restore;
      }
      if (method === "work.history.decide") {
        host.branches = [];
        return { left: 0 };
      }
      throw new Error(`unexpected ${method}`);
    },
    onPush: (listener: (push: never) => void) => (host.pushes.add(listener), () => host.pushes.delete(listener)),
    onOpen: (listener: () => void) => (host.opens.add(listener), () => host.opens.delete(listener)),
    onClose: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});

import { CanvasSeat } from "../canvas/CanvasSeat";
import { canvasOf, keepState, resetCanvasStore } from "../canvas/store";
import { layoutOf, type HistoryState } from "./HistoryCanvas";

const ITEM: CanvasItem = canvasItem("h1", { kind: "history", title: "Spring LAN run of show", source: { at: "file", host: "local", path: "/work/Run of show.tcdoc" } });

beforeEach(async () => {
  Element.prototype.scrollIntoView ??= () => undefined;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as never;
  localStorage.clear();
  resetCanvasStore();
  host.calls = [];
  host.branches = [];
  host.restore = { mode: "direct" };
  host.failBranches = false;
  host.failRestore = false;
  host.failVersions = false;
  host.toasts = [];
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

async function seat(state?: HistoryState) {
  // Each test its own source, so the history store's answers do not carry over.
  const item = { ...ITEM, id: `h${Math.random()}`, source: { ...ITEM.source, path: `/work/${Math.random()}.tcdoc` } } as CanvasItem;
  if (state) keepState(item.id, state);
  host.current = fakeHost([item], host as never);
  const view = render(
    <CanvasSeat session={{ id: "t1", environmentId: "local" }}>
      <div data-testid="thread" />
    </CanvasSeat>,
  );
  await waitFor(() => expect(canvasOf("t1").loaded).toBe(true));
  await act(async () => {});
  return view;
}

describe("the history canvas", () => {
  it("lists the versions by who and why; two picked compare in one column, the change in its sentence", async () => {
    const { container } = await seat();
    await waitFor(() => expect(screen.getByText("Wrote the morning")).toBeTruthy());
    expect(screen.getByText("Venue for the spring LAN")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    for (const box of screen.getAllByRole("checkbox", { name: /Pick the .* version/, hidden: true })) fireEvent.click(box);
    const bar = () => container.querySelector("[data-canvas-bar]") as HTMLElement;
    await waitFor(() => expect(within(bar()).getByRole("button", { name: "Compare" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(bar()).getByRole("button", { name: "Compare" }));
    await waitFor(() => expect(container.querySelector("[data-row]")).toBeTruthy());
    expect(host.calls.find((c) => c.method === "work.history.compare")!.params).toMatchObject({ from: "v1", to: "v2" });
    // The struck words, then the new ones; the added block tinted whole.
    const changed = container.querySelector('[data-row="0"]') as HTMLElement;
    expect(changed.querySelector(".line-through")!.textContent).toBe("8:00");
    expect(changed.querySelector(".bg-\\(--add-bg\\)")!.textContent).toBe("7:30");
    expect(container.querySelector('[data-row="1"]')!.textContent).toBe("8:30 AM Check-in opens");
    // A table's changed cell, older words struck and newer added, the right way round.
    expect(container.querySelector('[data-row="2"] td .line-through')!.textContent).toBe("Alex Kim");
    expect(container.querySelector('[data-row="2"] td .bg-\\(--add-bg\\)')!.textContent).toBe("Sam Ortiz");
    // The bar: back to History, the two pickers, who made the change and the count.
    expect(bar().textContent).toContain("Venue for the spring LAN");
    expect(within(bar()).getByText("1/3")).toBeTruthy();
    fireEvent.click(within(bar()).getByRole("button", { name: "Next change" }));
    await waitFor(() => expect(within(bar()).getByText("2/3")).toBeTruthy());
    // The current change is outlined where it is written: the added block's words, and nothing of the first change.
    expect(container.querySelector('[data-row="1"] .outline-1')!.textContent).toBe("8:30 AM Check-in opens");
    expect(container.querySelector('[data-row="0"] .outline-1')).toBeNull();
  });

  it("side by side: the older words left, the newer right, a blank where a side has nothing", async () => {
    const { container } = await seat({ view: "compare", from: "v1", to: "v2", layout: "sxs" });
    await waitFor(() => expect(container.querySelector("[data-row]")).toBeTruthy());
    const [left, right] = [...container.querySelectorAll('[data-row="0"]')] as HTMLElement[];
    expect(left!.textContent).toBe("8:00 AM Setup crew at the loading dock");
    expect(right!.textContent).toBe("7:30 AM Setup crew at the loading dock");
    const [gap, added] = [...container.querySelectorAll('[data-row="1"]')] as HTMLElement[];
    expect(gap!.querySelector(".bg-\\(--diff-gap\\)")).toBeTruthy();
    expect(added!.textContent).toBe("8:30 AM Check-in opens");
  });

  it("a restore of his own document is written at once, with Undo", async () => {
    host.restore = { mode: "direct", versionId: "v3", beforeVersionId: "v2b" };
    const { container } = await seat();
    await waitFor(() => expect(screen.getByText("Wrote the morning")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Restore", hidden: true })[0]!);
    await waitFor(() => expect((container.querySelector("[data-canvas-bar]") as HTMLElement).textContent).toMatch(/Restored the .* version/));
    expect(host.calls.find((c) => c.method === "work.history.restore")!.params).toMatchObject({ versionId: "v1" });
    // Undo goes back to the version cut just before the restore, which holds what was typed since.
    fireEvent.click(within(container.querySelector("[data-canvas-bar]") as HTMLElement).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(host.calls.filter((c) => c.method === "work.history.restore").map((c) => c.params.versionId)).toEqual(["v1", "v2b"]));
  });

  it("a branch waits for him: the frame's stepper steps it, Accept takes the current row", async () => {
    const diff = diffBlocks(OLD, NEW);
    host.branches = [{ id: "b1", baseVersionId: "v2", authors: [AGENT], label: "Suggestions", at: 1, editedAt: Date.now(), diff }];
    const { container } = await seat();
    await waitFor(() => expect(screen.getByText("Waiting for you")).toBeTruthy());
    fireEvent.click(screen.getByText("3 changes"));
    const bar = () => container.querySelector("[data-canvas-bar]") as HTMLElement;
    await waitFor(() => expect(within(bar()).getByRole("button", { name: "Accept" })).toBeTruthy());
    fireEvent.click(within(bar()).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(host.calls.find((c) => c.method === "work.history.decide")).toBeTruthy());
    expect(host.calls.find((c) => c.method === "work.history.decide")!.params).toMatchObject({ branchId: "b1", which: ["a"], accept: true });
    // The host now has nothing waiting: the views ask again and the review gives way to the list.
    await waitFor(() => expect(screen.getByText("Wrote the morning")).toBeTruthy());
    expect(screen.queryByText("Waiting for you")).toBeNull();
  });

  it("keeps Compare in the bar from the first frame, waiting for two ticks, so a tick never pushes the list", async () => {
    const { container } = await seat();
    await waitFor(() => expect(screen.getByText("Wrote the morning")).toBeTruthy());
    const compare = within(container.querySelector("[data-canvas-bar]") as HTMLElement).getByRole("button", { name: "Compare" });
    expect(compare.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getAllByRole("checkbox", { name: /Pick the .* version/, hidden: true })[0]!);
    expect(compare.hasAttribute("disabled")).toBe(true);
  });

  it("says suggestions that did not load on the state line with Retry, the versions still listed", async () => {
    host.failBranches = true;
    const { container } = await seat();
    await waitFor(() => expect(container.querySelector("[data-canvas-state='failed']")?.textContent).toContain("Suggestions did not load"));
    // The versions still list under it.
    expect(screen.getByText("Wrote the morning")).toBeTruthy();
    host.failBranches = false;
    fireEvent.click(within(container.querySelector("[data-canvas-state]") as HTMLElement).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(container.querySelector("[data-canvas-state]")).toBeNull());
  });

  it("says suggestions that did not load on a review's state line, and draws no bones under it", async () => {
    host.failBranches = true;
    const review = await seat({ view: "review", branchId: "b1" });
    await waitFor(() => expect(review.container.querySelector("[data-canvas-state='failed']")?.textContent).toContain("The suggestions did not load"));
    expect(review.container.querySelector("[data-canvas-body] [data-slot=skeleton]")).toBeNull();
  });

  it("says a refused restore once, as a toast, and leaves the state line to a source that cannot be reached", async () => {
    host.failRestore = true;
    const { container } = await seat();
    await waitFor(() => expect(screen.getByText("Wrote the morning")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Restore", hidden: true })[0]!);
    await waitFor(() => expect(host.toasts).toEqual(["error: That version is gone"]));
    expect(container.querySelector("[data-canvas-state]")).toBeNull();
  });

  it("draws a waiting branch as one list button, with the item's focus ring", async () => {
    host.branches = [{ id: "b1", baseVersionId: "v2", authors: [AGENT], label: "Suggestions", at: 1, editedAt: Date.now(), diff: diffBlocks(OLD, NEW) }];
    await seat();
    const row = (await screen.findByText("3 changes")).closest("button")!;
    expect(row.getAttribute("data-slot")).toBe("item");
    expect(row.className).toContain("focus-ring");
  });

  it("draws one column under two 420px sides, whatever was chosen", () => {
    expect(layoutOf({ layout: "sxs" }, 600)).toBe("one");
    expect(layoutOf({ layout: "sxs" }, 900)).toBe("sxs");
    expect(layoutOf(undefined, 900)).toBe("sxs");
    // A body not yet measured keeps the choice.
    expect(layoutOf({ layout: "sxs" }, 0)).toBe("sxs");
  });

  it("says versions that did not load on a compare's state line with Retry, when the diff itself came", async () => {
    host.failVersions = true;
    const { container } = await seat({ view: "compare", from: "v1", to: "v2" });
    await waitFor(() => expect(container.querySelector("[data-row]")).toBeTruthy());
    await waitFor(() => expect(container.querySelector("[data-canvas-state='failed']")?.textContent).toContain("The versions did not load"));
    host.failVersions = false;
    fireEvent.click(within(container.querySelector("[data-canvas-state]") as HTMLElement).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(container.querySelector("[data-canvas-state]")).toBeNull());
  });
});
