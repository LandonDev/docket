// @vitest-environment jsdom
/**
 * The Templates view: still tiles while the shelf loads, its error with Retry,
 * the empty state with Add…, a press that makes (or asks the fields through
 * the dialog), the menu's verbs, Remove of his own asking through a confirm
 * when the host has no Trash and offering Undo when it has, Show hidden only
 * with starters hidden, and Add… and a drop that put a file of the workspace's
 * own host on the shelf while no thread starts.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Template } from "@shared/work/templates";

const host: { asked: { method: string; params: Record<string, unknown> }[]; answer: (method: string, params: Record<string, unknown>) => unknown; primary: string } = { asked: [], answer: () => null, primary: "box" };
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    primary: () => ({ environmentId: host.primary }),
    environment: (id: string) => ({ id, name: id === "box" ? "The box" : "Mac" }),
    linkOf: () => ({
      onPush: () => () => {},
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
const toasts: { kind: string; title: string; options?: { action?: { label: string; onClick: () => void } } }[] = [];
vi.mock("../../components/ui/toaster", async (original) => {
  const toast = Object.assign((title: string, options?: never) => toasts.push({ kind: "plain", title, options }), {
    error: (title: string) => toasts.push({ kind: "error", title }),
    success: (title: string, options?: never) => toasts.push({ kind: "success", title, options }),
  });
  return { ...(await original<object>()), loadToast: async () => toast };
});

const { View, Head } = await import("./TemplatesView");
const { workTemplatePort } = await import("../../lib/workSwitch");

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

  it("is No templates, with Add…, when every starter is hidden and he has none", async () => {
    list = { templates: [], hidden: 3 };
    picked.paths = ["/w/Desktop/Budget.xlsx"];
    render(<View {...props} />);
    await settle();
    expect(screen.getByText("No templates")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add…" }));
    await settle();
    expect(asked("work.templates.save")).toEqual([{ workspaceId: "ws", source: { at: "file", host: "box", path: "/w/Desktop/Budget.xlsx" } }]);
  });

  it("makes a template with no fields on a press and opens it in Files, and hands one with fields to the dialog", async () => {
    const open = vi.fn();
    workTemplatePort.set({ open, save: () => {} });
    render(<View {...props} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Crew memo" }));
    await settle();
    expect(asked("work.templates.make").map((p) => p.template)).toEqual(["job:Crew memo.docx"]);
    expect(asked("work.files.open")).toEqual([{ workspaceId: "ws", ref: { at: "file", host: "box", path: "/w/Dummy Esports/Crew memo.docx" } }]);
    fireEvent.click(screen.getByRole("button", { name: "Game report" }));
    expect(open).toHaveBeenCalledWith({ workspaceId: "ws", template: REPORT });
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

  it("hides a starter at once, and asks before deleting one of his own while there is no Trash", async () => {
    render(<View {...props} />);
    await settle();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Season log" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide" }));
    await settle();
    expect(asked("work.templates.remove")).toEqual([{ workspaceId: "ws", template: LOG.id }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Crew memo" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await settle();
    const confirm = screen.getByRole("alertdialog");
    expect(within(confirm).getByText("Remove Crew memo?")).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await settle();
    expect(asked("work.templates.remove").slice(1)).toEqual([{ workspaceId: "ws", template: MEMO.id }, { workspaceId: "ws", template: MEMO.id, confirmed: true }]);
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

  it("adds only a file on the workspace's own host, and says so in one line from another machine", async () => {
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
    expect(toasts).toEqual([{ kind: "error", title: "Only a file on The box can be added for now" }]);
  });
});
