// @vitest-environment jsdom
/**
 * The Templates view: still tiles while the shelf loads, its error as the
 * frame's state line with Retry and Add… off, an empty shelf he narrowed
 * saying so with Show hidden (and no second Add…), a press that makes (or asks
 * the fields through the dialog) and opens a made file again rather than make a
 * second, the menu's verbs with their glyphs and the delete set apart, Hide
 * with its Undo, the Delete confirm in the app's words, Show hidden only with
 * starters hidden and Add… never moving for it, and Add… and a drop that put
 * files of the workspace's own host on the shelf one add at a time, each file
 * tried and one message for those left out, while no thread starts.
 */
import { act, cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Template } from "@shared/work/templates";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";

const host: { asked: { method: string; params: Record<string, unknown> }[]; answer: (method: string, params: Record<string, unknown>) => unknown; primary: string } = { asked: [], answer: () => null, primary: "box" };
/** The link's socket opening: what a host read asks again on. */
const opens = new Set<() => void>();
/** The host's pushes. */
const pushes = new Set<(push: unknown) => void>();
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    primary: () => ({ environmentId: host.primary }),
    environment: (id: string) => ({ id, name: id === "box" ? "The box" : "Mac" }),
    linkOf: () => ({
      connected: true,
      onOpen: (listener: () => void) => (opens.add(listener), () => void opens.delete(listener)),
      onPush: (listener: (push: unknown) => void) => (pushes.add(listener), () => void pushes.delete(listener)),
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ method, params });
        return host.answer(method, params);
      },
    }),
  },
}));
vi.mock("../../lib/tcserver/workspaces", async (original) => {
  const workspaces = [{ id: "ws", environmentId: "box", name: "Dummy Esports", path: "/w/Dummy Esports" }];
  return { ...(await original<object>()), useWorkspaces: () => workspaces, workspaceStore: { getSnapshot: () => ({ workspaces }) } };
});
const picked: { paths: string[] | null } = { paths: null };
vi.mock("../../lib/fs", async (original) => ({ ...(await original<object>()), pickFiles: async () => picked.paths }));
vi.mock("../../lib/native", async (original) => ({ ...(await original<object>()), getPathForFile: (f: File) => (f.name === "memory.docx" ? "" : `/w/Desktop/${f.name}`) }));
const toasts: { kind: string; title: string; options?: { description?: string; action?: { label: string; onClick: () => void } } }[] = [];
vi.mock("../../components/ui/toaster", async (original) => {
  const toast = Object.assign((title: string, options?: never) => toasts.push({ kind: "plain", title, options }), {
    error: (title: string, options?: never) => toasts.push({ kind: "error", title, ...(options ? { options } : {}) }),
    success: (title: string, options?: never) => toasts.push({ kind: "success", title, options }),
  });
  return { ...(await original<object>()), loadToast: async () => toast };
});

// Files' own opener (work/files/openFrom.ts), standing in: it asks the workspace's host to open the file in a tab, then shows Files.
const filesOpened: { workspace: { id: string; environmentId: string }; what: { ref: unknown; name: string } }[] = [];
vi.mock("../files/openFrom", () => ({
  openInFiles: async (workspace: { id: string; environmentId: string }, what: { ref: unknown; name: string }) => {
    filesOpened.push({ workspace, what });
    const { registry } = await import("../../lib/connection");
    await registry.linkOf(workspace.environmentId).request("work.files.open", { workspaceId: workspace.id, ref: what.ref });
    const { openWorkView } = await import("../../lib/workSwitch");
    openWorkView({ workspaceId: workspace.id, view: "files" });
  },
}));

const { View, Head } = await import("./TemplatesView");
const { workTemplatePort } = await import("./open");

const tpl = (id: string, name: string, fields: string[] = []): Template => ({ id, name, kind: "document", form: "docx", where: id.startsWith("job:") ? "job" : id.startsWith("all:") ? "all" : "starter", fields, source: { at: "file", host: "box", path: `/w/Templates/${name}.docx` } });
const MEMO = tpl("job:Crew memo.docx", "Crew memo");
const REPORT = tpl("starter:ref/game-report", "Game report", ["Home", "Away"]);
const LOG = tpl("starter:ref/season-log", "Season log");
const props = { env: "box", workspace: { id: "ws", environmentId: "box", name: "Dummy Esports" }, sector: "ref", lifeos: {}, startThread: () => {} } as never;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const asked = (method: string) => host.asked.filter((a) => a.method === method).map((a) => a.params);
let list: { templates: Template[]; hidden: number } = { templates: [], hidden: 0 };

beforeEach(() => {
  host.asked.length = 0;
  host.primary = "box";
  toasts.length = 0;
  picked.paths = null;
  list = { templates: [MEMO, REPORT, LOG], hidden: 0 };
  host.answer = (method, params) => {
    if (method === "work.templates.list") return list;
    if (method === "work.templates.make") return { source: { at: "file", host: "box", path: "/w/Dummy Esports/Crew memo.docx" }, kind: "document", title: "Crew memo", unfilled: [] };
    if (method === "work.templates.save") return { ...MEMO, id: "job:Season log.xlsx", source: { at: "file", host: "box", path: "/w/Dummy Esports/Templates/Season log.docx" } };
    if (method === "work.templates.remove") return params.template === MEMO.id && !params.confirmed ? { confirm: true } : {};
    return {};
  };
});
afterEach(() => {
  cleanup();
  workTemplatePort.set(null);
});

describe("the Templates view", () => {
  it("shows still tiles in the grid's shape while the shelf loads", () => {
    host.answer = () => new Promise(() => {});
    render(<View {...props} />);
    const bones = screen.getByLabelText("Loading templates");
    expect(bones.getAttribute("aria-busy")).toBe("true");
    expect(bones.querySelector(".grid")!.className).toContain("grid-cols-[repeat(auto-fill,minmax(148px,1fr))]");
    expect(bones.querySelectorAll(".aspect-\\[4\\/3\\]")).toHaveLength(8);
  });

  it("says the shelf did not load, with Retry", async () => {
    host.answer = () => Promise.reject(new Error("refused: the box did not answer"));
    render(<View {...props} />);
    await settle();
    expect(screen.getByText("Templates did not load")).toBeTruthy();
    host.answer = () => list;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByRole("button", { name: "Crew memo" })).toBeTruthy();
  });

  it("says the shelf did not load as the frame's state line, with Add… off until it does", async () => {
    host.answer = () => Promise.reject(new Error("refused: the box did not answer"));
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await settle();
    const line = document.querySelector('[data-view-state="failed"]')!;
    expect(line.textContent).toContain("Templates did not load");
    expect(line.textContent).toContain("The box did not answer");
    expect(screen.queryByText("No templates")).toBeNull();
    expect(screen.getByRole("button", { name: "Add…" }).hasAttribute("disabled")).toBe(true);
    host.answer = () => list;
    fireEvent.click(within(line as HTMLElement).getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByRole("button", { name: "Add…" }).hasAttribute("disabled")).toBe(false);
  });

  it("is No templates, saying what he hid, with Show hidden said once and no second Add…", async () => {
    list = { templates: [], hidden: 3 };
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await settle();
    // The header's ⋯ stands down: the empty state carries Show hidden.
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Add…" })).toHaveLength(1);
    expect(screen.getByText("No templates")).toBeTruthy();
    expect(screen.getByText("3 starters are hidden")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show hidden" }));
    await settle();
    expect(asked("work.templates.unhide")).toEqual([{ workspaceId: "ws" }]);
  });

  it("is No templates alone when nothing was hidden", async () => {
    list = { templates: [], hidden: 0 };
    render(<View {...props} />);
    await settle();
    expect(screen.getByText("No templates")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("makes a template with no fields on a press and opens it in Files, and hands one with fields to the dialog", async () => {
    const open = vi.fn();
    workTemplatePort.set({ open, save: () => {} });
    render(<View {...props} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Crew memo" }));
    await settle();
    expect(asked("work.templates.make").map((p) => p.template)).toEqual(["job:Crew memo.docx"]);
    await waitFor(() => expect(asked("work.files.open")).toEqual([{ workspaceId: "ws", ref: { at: "file", host: "box", path: "/w/Dummy Esports/Crew memo.docx" } }]));
    // The make is over once Files has the file: the next press is taken.
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Game report" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith({ workspaceId: "ws", template: REPORT }));
    expect(asked("work.templates.make")).toHaveLength(1);
  });

  it("edits a starter as his own copy, and opens his own in place", async () => {
    render(<View {...props} />);
    await settle();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Season log" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit a copy" }));
    await settle();
    expect(asked("work.templates.save")).toEqual([{ workspaceId: "ws", source: LOG.source, name: "Season log" }]);
    expect(asked("work.files.open").map((p) => p.ref)).toEqual([{ at: "file", host: "box", path: "/w/Dummy Esports/Templates/Season log.docx" }]);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Crew memo" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    await settle();
    expect(asked("work.files.open").map((p) => p.ref)).toContainEqual(MEMO.source);
  });

  it("hides a starter at once with Undo for that one, and asks before deleting one of his own while there is no Trash", async () => {
    render(<View {...props} />);
    await settle();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Season log" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide" }));
    await settle();
    expect(asked("work.templates.remove")).toEqual([{ workspaceId: "ws", template: LOG.id }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(toasts.map((t) => [t.title, t.options?.action?.label])).toEqual([["Hidden", "Undo"]]);
    toasts[0]!.options!.action!.onClick();
    await settle();
    expect(asked("work.templates.unhide")).toEqual([{ workspaceId: "ws", template: LOG.id }]);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Crew memo" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await settle();
    const confirm = screen.getByRole("alertdialog");
    expect(within(confirm).getByRole("heading").textContent).toBe("Delete “Crew memo”?");
    // A job's template: the title says it all.
    expect(confirm.querySelector('[data-slot="alert-dialog-description"], [data-slot="dialog-description"]')).toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await settle();
    expect(asked("work.templates.remove").slice(1)).toEqual([{ workspaceId: "ws", template: MEMO.id }, { workspaceId: "ws", template: MEMO.id, confirmed: true }]);
  });

  it("says a template of All jobs goes from every job on its host before it is deleted", async () => {
    const WEEKLY = tpl("all:Weekly.docx", "Weekly");
    list = { templates: [MEMO, WEEKLY], hidden: 0 };
    host.answer = (method) => (method === "work.templates.list" ? list : method === "work.templates.remove" ? { confirm: true } : {});
    render(<View {...props} />);
    await settle();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Weekly" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await settle();
    expect(within(screen.getByRole("alertdialog")).getByText("It goes from every job on this computer.")).toBeTruthy();
  });

  it("gives each menu row its glyph and sets his own Remove apart as the one red row", async () => {
    render(<View {...props} />);
    await settle();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Crew memo" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.every((i) => i.querySelector("svg"))).toBe(true);
    const remove = screen.getByRole("menuitem", { name: "Remove" });
    expect(remove.previousElementSibling?.getAttribute("role")).toBe("separator");
    expect(remove.getAttribute("data-variant") ?? remove.className).toMatch(/destructive/);
  });

  it("offers Undo when his own went to Files' Trash, which puts it back", async () => {
    host.answer = (method) => (method === "work.templates.list" ? list : method === "work.templates.remove" ? { trashed: ["tr1"] } : {});
    render(<View {...props} />);
    await settle();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Crew memo" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(toasts.map((t) => [t.title, t.options?.action?.label])).toEqual([["Moved to Trash", "Undo"]]);
    toasts[0]!.options!.action!.onClick();
    await settle();
    const restore = asked("work.files.restore");
    expect(restore).toHaveLength(1);
    expect(restore[0]).toMatchObject({ workspaceId: "ws", ids: ["tr1"] });
    expect(typeof restore[0]!.op).toBe("string");
  });

  it("moves his own between this job and all jobs", async () => {
    render(<View {...props} />);
    await settle();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Crew memo" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Use in all jobs" }));
    await settle();
    expect(asked("work.templates.move")).toEqual([{ workspaceId: "ws", template: MEMO.id, everywhere: true }]);
  });

  it("puts Show hidden in the header's menu only while starters are hidden", async () => {
    const { unmount } = render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await settle();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    unmount();
    list = { templates: [MEMO], hidden: 2 };
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show hidden" }));
    await settle();
    expect(asked("work.templates.unhide")).toEqual([{ workspaceId: "ws" }]);
  });

  it("takes a file dropped on it as a template, and keeps the drop so no thread starts", async () => {
    render(<View {...props} />);
    await settle();
    const view = document.querySelector("[data-templates-view]")!;
    const file = new File(["x"], "Budget.xlsx");
    const data = { types: ["Files"], files: [file], dropEffect: "none" };
    fireEvent.dragEnter(view, { dataTransfer: data });
    expect(screen.getByText("Drop to add")).toBeTruthy();
    const kept = fireEvent.drop(view, { dataTransfer: data });
    await settle();
    expect(kept).toBe(false);
    expect(screen.queryByText("Drop to add")).toBeNull();
    expect(asked("work.templates.save")).toEqual([{ workspaceId: "ws", source: { at: "file", host: "box", path: "/w/Desktop/Budget.xlsx" } }]);
  });

  it("adds only a file on the workspace's own host, and says so in one message from another machine", async () => {
    host.primary = "mac";
    picked.paths = ["/Users/sam/Budget.xlsx"];
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add…" }));
    await settle();
    expect(asked("work.templates.save")).toEqual([]);
    expect(toasts).toEqual([{ kind: "error", title: "Budget.xlsx was not added", options: { description: "Only a file on The box can be added for now" } }]);
  });

  it("tries every file of an add and names the ones left out in one message", async () => {
    host.answer = (method, params) => {
      if (method === "work.templates.list") return list;
      if (method === "work.templates.save" && String((params.source as { path: string }).path).endsWith(".png")) throw new Error("refused: only a document, sheet or deck can be a template");
      return MEMO;
    };
    picked.paths = ["/w/Desktop/Logo.png", "/w/Desktop/Budget.xlsx", "/w/Desktop/Brief.docx"];
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add…" }));
    await settle();
    await settle();
    expect(asked("work.templates.save").map((p) => (p.source as { path: string }).path)).toEqual(["/w/Desktop/Logo.png", "/w/Desktop/Budget.xlsx", "/w/Desktop/Brief.docx"]);
    expect(toasts).toEqual([{ kind: "error", title: "Logo.png was not added", options: { description: "Only a document, sheet or deck can be a template" } }]);
  });

  it("runs one add at a time for a workspace, whether from Add… or a drop", async () => {
    let finish: () => void = () => {};
    host.answer = (method) => (method === "work.templates.list" ? list : method === "work.templates.save" ? new Promise((done) => (finish = () => done(MEMO))) : {});
    picked.paths = ["/w/Desktop/Budget.xlsx"];
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add…" }));
    await settle();
    expect(screen.getByRole("button", { name: "Add…" }).hasAttribute("disabled")).toBe(true);
    const view = document.querySelector("[data-templates-view]")!;
    fireEvent.drop(view, { dataTransfer: { types: ["Files"], files: [new File(["x"], "Other.docx")] } });
    await settle();
    expect(asked("work.templates.save")).toHaveLength(1);
    await act(async () => finish());
    await settle();
    fireEvent.drop(view, { dataTransfer: { types: ["Files"], files: [new File(["x"], "Other.docx")] } });
    await settle();
    expect(asked("work.templates.save")).toHaveLength(2);
    await act(async () => finish());
  });

  it("names a dropped file with no path on this computer among those left out", async () => {
    render(<View {...props} />);
    await settle();
    const view = document.querySelector("[data-templates-view]")!;
    fireEvent.drop(view, { dataTransfer: { types: ["Files"], files: [new File(["x"], "memory.docx"), new File(["x"], "Budget.xlsx")] } });
    await settle();
    await settle();
    expect(asked("work.templates.save").map((p) => (p.source as { path: string }).path)).toEqual(["/w/Desktop/Budget.xlsx"]);
    expect(toasts).toEqual([{ kind: "error", title: "memory.docx was not added", options: { description: "Only a file saved on this computer can be added" } }]);
  });

  it("keeps Add… in its place when the ⋯ for hidden starters comes and goes", async () => {
    list = { templates: [MEMO], hidden: 2 };
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await settle();
    const head = screen.getByRole("button", { name: "Add…" }).parentElement!;
    // Add… is the header's last control; the ⋯ arrives before it, so Add… never shifts.
    expect(head.lastElementChild).toBe(screen.getByRole("button", { name: "Add…" }));
    expect(screen.getByRole("button", { name: "More" }).compareDocumentPosition(screen.getByRole("button", { name: "Add…" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens a made file again when its open failed, and never makes a second", async () => {
    let opens = 0;
    host.answer = (method) => {
      if (method === "work.templates.list") return list;
      if (method === "work.templates.make") return { source: { at: "file", host: "box", path: "/w/Dummy Esports/Crew memo.docx" }, kind: "document", title: "Crew memo", unfilled: [] };
      if (method === "work.files.open" && opens++ === 0) throw new Error("refused: the Files view is busy");
      return {};
    };
    render(<View {...props} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Crew memo" }));
    await settle();
    await settle();
    expect(toasts.map((t) => [t.kind, t.title, t.options?.description, t.options?.action?.label])).toEqual([["error", "Crew memo was made but did not open", "The Files view is busy", "Open"]]);
    fireEvent.click(screen.getByRole("button", { name: "Crew memo" }));
    await settle();
    expect(asked("work.templates.make")).toHaveLength(1);
    expect(asked("work.files.open")).toHaveLength(2);
  });

  it("says which template was not made, with the host's words", async () => {
    host.answer = (method) => (method === "work.templates.list" ? list : method === "work.templates.make" ? Promise.reject(new Error("refused: the workspace's folder is gone")) : {});
    render(<View {...props} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Crew memo" }));
    await settle();
    await settle();
    expect(toasts).toEqual([{ kind: "error", title: "Crew memo was not made", options: { description: "The workspace's folder is gone" } }]);
  });

  it("refuses a drop where he can see it while an add runs: no wash, no copy cursor, nothing sent", async () => {
    let finish: () => void = () => {};
    host.answer = (method) => (method === "work.templates.list" ? list : method === "work.templates.save" ? new Promise((done) => (finish = () => done(MEMO))) : {});
    picked.paths = ["/w/Desktop/Budget.xlsx"];
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add…" }));
    await settle();
    const view = document.querySelector("[data-templates-view]")!;
    const data = { types: ["Files"], files: [new File(["x"], "Other.docx")], dropEffect: "copy" };
    fireEvent.dragEnter(view, { dataTransfer: data });
    expect(screen.queryByText("Drop to add")).toBeNull();
    // Kept from the document's own drop (which would start a thread), but no copy is offered.
    const kept = fireEvent.dragOver(view, { dataTransfer: data });
    expect(kept).toBe(false);
    expect(data.dropEffect).toBe("none");
    fireEvent.drop(view, { dataTransfer: data });
    await settle();
    expect(asked("work.templates.save")).toHaveLength(1);
    await act(async () => finish());
    await settle();
    // Free again: the cue comes back.
    fireEvent.dragEnter(view, { dataTransfer: { ...data, dropEffect: "copy" } });
    expect(screen.getByText("Drop to add")).toBeTruthy();
  });

  it("shows Edit a copy's wait on its tile and takes no second pick while it runs", async () => {
    let finish: () => void = () => {};
    host.answer = (method) => {
      if (method === "work.templates.list") return list;
      if (method === "work.templates.save") return new Promise((done) => (finish = () => done({ ...LOG, id: "job:Season log.xlsx", where: "job" })));
      return {};
    };
    render(<View {...props} />);
    await settle();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Season log" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit a copy" }));
    // Past the 150ms a make waits before its spinner shows.
    await act(async () => void (await new Promise((r) => setTimeout(r, 200))));
    const tile = document.querySelector('[data-tile="starter:ref/season-log"]')!;
    expect(tile.querySelector('[data-slot="spinner"]')).not.toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Season log" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit a copy" }));
    await settle();
    expect(asked("work.templates.save")).toHaveLength(1);
    await act(async () => finish());
    await settle();
    expect(asked("work.files.open")).toHaveLength(1);
  });

  it("keeps the shelf on screen when a refresh fails", async () => {
    render(<View {...props} />);
    await settle();
    expect(screen.getByRole("button", { name: "Crew memo" })).toBeTruthy();
    host.answer = (method) => (method === "work.templates.list" ? Promise.reject(new Error("refused: the box did not answer")) : {});
    act(() => pushes.forEach((l) => l({ push: "work.templates", workspaceId: "ws" })));
    await settle();
    await settle();
    expect(asked("work.templates.list")).toHaveLength(2);
    // A failed read over a shelf already shown keeps the shelf, with no state line over it.
    expect(screen.getByRole("button", { name: "Crew memo" })).toBeTruthy();
    expect(document.querySelector('[data-view-state="failed"]')).toBeNull();
  });

  it("asks for the shelf again on a new socket after a read that did not answer", async () => {
    host.answer = (method) => (method === "work.templates.list" ? Promise.reject(new Error("refused: the box did not answer")) : {});
    render(<View {...props} />);
    await settle();
    expect(document.querySelector('[data-view-state="failed"]')).not.toBeNull();
    host.answer = (method) => (method === "work.templates.list" ? list : {});
    act(() => opens.forEach((l) => l()));
    await settle();
    expect(screen.getByRole("button", { name: "Crew memo" })).toBeTruthy();
  });

  it("gives the state line's cut detail its whole text as a tip, the shared line itself untouched", async () => {
    await act(async () => {
      await tooltipChunk.load();
      warmTooltips();
    });
    const spy = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.slot === "status-detail" ? 300 : 10;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    try {
      host.answer = () => Promise.reject(new Error("refused: the box did not answer in time for this read"));
      render(<View {...props} />);
      await settle();
      const tip = document.querySelector("[data-state-tip]")!;
      expect(tip.getAttribute("data-slot")).toBe("tooltip-trigger");
      expect(tip.querySelector('[data-view-state="failed"]')).not.toBeNull();
    } finally {
      spy.mockRestore();
      vi.restoreAllMocks();
    }
  });
});
