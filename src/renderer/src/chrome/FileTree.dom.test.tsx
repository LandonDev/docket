// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../lib/fs";

const ROOT = "/repo";

const state = vi.hoisted(() => ({
  dirs: new Map<string, FsEntry[]>(),
  failing: new Set<string>(),
}));

function entry(path: string, isDir = false): FsEntry {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, isDir, ignored: false };
}

vi.mock("../lib/fs", () => ({
  basename: (path: string) => path.slice(path.lastIndexOf("/") + 1),
  listDir: async (_env: string, path: string) => {
    if (state.failing.has(path)) throw new Error("server router not bound (fs.listPath)");
    return state.dirs.get(path) ?? [];
  },
  copyPath: vi.fn(),
  createPath: vi.fn(),
  deletePath: vi.fn(),
  movePath: vi.fn(),
  renamePath: vi.fn(),
  revealPath: vi.fn(),
}));
vi.mock("../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
const may = vi.hoisted(() => ({ write: true, held: null as string | null }));
vi.mock("../lib/linkMayCore", () => ({ useLinkMay: () => may.write }));
vi.mock("../lib/connection/degraded", () => ({ useHostHeld: () => may.held }));
vi.mock("../lib/tcserver/projects", () => ({ environmentOfCwd: () => "local", hostOfCwd: () => "local" }));
vi.mock("../lib/editorConfig", () => ({ useEditorConfig: () => null }));
vi.mock("../lib/openInEditor", () => ({ editorLabelFor: () => null, openInEditor: vi.fn() }));
vi.mock("../lib/editorRename", () => ({ applyBeforeMove: vi.fn(), applyWillRename: vi.fn() }));
vi.mock("../lib/projectWatch", () => ({ watchCwd: () => () => {}, onFileEvent: () => () => {} }));
vi.mock("../surfaces/chunks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../surfaces/chunks")>()),
  editorChunk: { preload: () => {} },
  mediaChunk: { preload: () => {} },
}));
vi.mock("./ConfirmDialog", () => ({ useConfirm: () => async () => true }));

import { FileTree } from "./FileTree";
import { renamePath } from "../lib/fs";

async function mount() {
  const onOpenFile = vi.fn();
  const view = render(<FileTree cwd={ROOT} onOpenFile={onOpenFile} />);
  await screen.findByText("README.md");
  return { ...view, onOpenFile };
}

/** A row of the open file menu, and whether it is disabled. */
async function row(name: string): Promise<{ el: HTMLElement; disabled: boolean }> {
  const menu = await screen.findByRole("menu", { name: "File actions" });
  const el = within(menu).getByText(name, { selector: "span" }).closest<HTMLElement>("[role='menuitem']")!;
  return { el, disabled: el.getAttribute("aria-disabled") === "true" };
}

describe("FileTree", () => {
  beforeEach(() => {
    state.dirs = new Map([
      [ROOT, [entry(`${ROOT}/src`, true), entry(`${ROOT}/README.md`)]],
      [`${ROOT}/src`, [entry(`${ROOT}/src/app.ts`)]],
    ]);
  });
  afterEach(cleanup);

  it("heads the tree with three named icon buttons and nothing else", async () => {
    const { container } = await mount();
    for (const name of ["New file", "New folder", "Collapse all"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    const header = screen.getByRole("button", { name: "New file" }).parentElement!;
    expect(header.querySelectorAll("button")).toHaveLength(3);
    expect(header.className).not.toContain("border-b");
    // The section's top row: 36px on the panel's 12px inset, as Changes, Build, Notes and Files all draw it.
    const top = header.closest('[data-slot="section-top"]')!;
    expect(top.className).toContain("h-9");
    expect(top.className).toContain("px-3");

    expect(container.querySelector("button[title]")).toBeNull();
  });

  it("opens with the root expanded and its children at the top level, no root row", async () => {
    await mount();
    const rows = screen.getAllByRole("treeitem");
    expect(rows.map((row) => row.dataset.path)).toEqual([`${ROOT}/src`, `${ROOT}/README.md`]);
    expect(rows.some((row) => row.dataset.path === ROOT)).toBe(false);
    expect(screen.getByRole("tree").getAttribute("aria-label")).toBe("repo files");
  });

  it("keeps the root's children after Collapse all and folds the folders", async () => {
    await mount();
    fireEvent.click(screen.getByRole("treeitem", { name: /src/ }));
    await screen.findByText("app.ts");
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByText("app.ts")).toBeNull();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("marks the selected row with aria-current and the muted fill", async () => {
    const { onOpenFile } = await mount();
    const readme = screen.getByRole("treeitem", { name: /README\.md/ });
    fireEvent.click(readme);
    expect(onOpenFile).toHaveBeenCalledWith(`${ROOT}/README.md`);
    expect(readme.getAttribute("aria-current")).toBe("true");
    expect(readme.className).toContain("bg-muted");
    expect(screen.getByRole("treeitem", { name: /src/ }).getAttribute("aria-current")).toBeNull();
  });

  it("aims the background context menu at the root", async () => {
    await mount();
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.contextMenu(screen.getByRole("tree"));
    expect((await row("Rename")).disabled).toBe(true);
    expect((await row("Delete")).disabled).toBe(true);
    expect((await row("Cut")).disabled).toBe(true);
    expect((await row("New file")).disabled).toBe(false);
    fireEvent.click((await row("Copy path")).el);
    expect(writeText).toHaveBeenCalledWith(ROOT);
  });

  it("offers Reveal only in the desktop app", async () => {
    await mount();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /README\.md/ }));
    const desktop = await screen.findByRole("menu", { name: "File actions" });
    expect(within(desktop).queryByText(/Reveal|containing folder/)).not.toBeNull();
    cleanup();
    // Web mode is a page with no preload bridge.
    const api = (window as { api?: unknown }).api;
    delete (window as { api?: unknown }).api;
    try {
      await mount();
      fireEvent.contextMenu(screen.getByRole("treeitem", { name: /README\.md/ }));
      const menu = await screen.findByRole("menu", { name: "File actions" });
      expect(within(menu).queryByText(/Reveal|containing folder/)).toBeNull();
    } finally {
      (window as { api?: unknown }).api = api;
    }
  });

  it("a row's context menu targets that row", async () => {
    await mount();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /README\.md/ }));
    expect((await row("Rename")).disabled).toBe(false);
    expect((await row("Delete")).disabled).toBe(false);
    // Each verb with its glyph, and the file tree's real keys.
    expect((await row("Rename")).el.querySelector("svg")).toBeTruthy();
    expect((await row("Rename")).el.querySelector("kbd")?.textContent).toBe("F2");
  });

  // rightpanel-03: a key that may only read opens and copies; nothing that changes the host's files is offered.
  it("offers a read key no New file, New folder, Rename or Delete", async () => {
    may.write = false;
    try {
      await mount();
      expect(screen.queryByRole("button", { name: "New file" })).toBeNull();
      expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
      expect(screen.getByRole("button", { name: "Collapse all" })).toBeTruthy();
      fireEvent.contextMenu(screen.getByRole("treeitem", { name: /README\.md/ }));
      expect((await row("Copy path")).disabled).toBe(false);
      const labels = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? "");
      for (const verb of ["Rename", "Delete", "New file", "Paste", "Duplicate", "Cut"]) expect(labels.some((l) => l.startsWith(verb))).toBe(false);
    } finally {
      may.write = true;
    }
  });

  // Round 2: the host away holds every write in place, the link's words their reason; Copy path and Cut stay.
  it("holds New file, New folder, Rename, Delete and Paste while the host is away", async () => {
    may.held = "The box is offline";
    try {
      await mount();
      for (const name of ["New file", "New folder"]) {
        const button = screen.getByRole("button", { name }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.closest("[data-held]")).not.toBeNull();
      }
      fireEvent.contextMenu(screen.getByRole("treeitem", { name: /README\.md/ }));
      expect((await row("Rename")).disabled).toBe(true);
      expect((await row("Delete")).disabled).toBe(true);
      expect((await row("Copy path")).disabled).toBe(false);
      expect((await row("Cut")).disabled).toBe(false);
    } finally {
      may.held = null;
    }
  });

  it("draws its rows on the panel's grid: 28px, 13px, rounded, inside the 12px inset", async () => {
    await mount();
    const readme = screen.getByRole("treeitem", { name: /README\.md/ });
    expect(readme.className).toContain("h-7");
    expect(readme.className).not.toContain("h-7.5");
    expect(readme.className).toContain("text-[13px]");
    expect(readme.className).toContain("rounded-lg");
    expect(readme.className).not.toContain("rounded-none");
    // The scroller's 4px and the row's own 8px make the panel's 12px inset.
    expect(screen.getByRole("tree").parentElement!.className).toContain("px-1");
    expect(readme.style.paddingLeft).toBe("8px");
  });

  it("turns one ChevronRight for a folder's fold, never swaps glyphs", async () => {
    await mount();
    const src = screen.getByRole("treeitem", { name: /src/ });
    const before = src.querySelector("svg")!;
    const chevron = () => src.querySelector("svg")!.getAttribute("class") ?? "";
    expect(chevron()).toContain("transition-transform");
    expect(chevron()).not.toContain("rotate-90");
    fireEvent.click(src);
    await screen.findByText("app.ts");
    // The same glyph, turned: a swap would mount a new svg.
    expect(src.querySelector("svg")).toBe(before);
    expect(chevron()).toContain("rotate-90");
  });

  it("puts no tooltip on a name that fits, and never the absolute path", async () => {
    const { container } = await mount();
    expect(container.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
    expect(screen.queryByText(`${ROOT}/README.md`)).toBeNull();
  });

  it("says an empty checkout with one Empty", async () => {
    const root = "/empty-checkout";
    state.dirs.set(root, []);
    render(<FileTree cwd={root} onOpenFile={vi.fn()} />);
    expect(await screen.findByText("No files")).toBeTruthy();
    expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
  });

  it("says a failed list as one red line with Retry, never the host's raw words", async () => {
    const root = "/failing-checkout";
    state.failing.add(root);
    state.dirs.set(root, [entry(`${root}/README.md`)]);
    render(<FileTree cwd={root} onOpenFile={vi.fn()} />);
    const line = await screen.findByRole("alert");
    expect(line.textContent).toContain("Couldn't list this folder");
    expect(line.className).toContain("text-destructive");
    expect(screen.queryByText(/router|fs\.listPath/)).toBeNull();
    expect(screen.queryByText("No files")).toBeNull();
    state.failing.delete(root);
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the line when Retry fails again", async () => {
    const root = "/still-failing";
    state.failing.add(root);
    render(<FileTree cwd={root} onOpenFile={vi.fn()} />);
    const line = await screen.findByRole("alert");
    const retry = within(line).getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    await vi.waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("alert").textContent).toContain("Couldn't list this folder");
    state.failing.delete(root);
  });

  describe("the rename field", () => {
    async function startRename(): Promise<HTMLInputElement> {
      await mount();
      fireEvent.contextMenu(screen.getByRole("treeitem", { name: /README\.md/ }));
      fireEvent.click((await row("Rename")).el);
      return (await screen.findByRole("textbox")) as HTMLInputElement;
    }
    beforeEach(() => {
      // jsdom has no layout: the field scrolls itself into view on open.
      Element.prototype.scrollIntoView = vi.fn();
      vi.mocked(renamePath).mockReset();
      vi.mocked(renamePath).mockResolvedValue(`${ROOT}/NOTES.md`);
    });

    it("opens focused with the name's stem selected", async () => {
      const input = await startRename();
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("README.md");
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
    });

    it("commits on Enter", async () => {
      const input = await startRename();
      fireEvent.change(input, { target: { value: "NOTES.md" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await vi.waitFor(() => expect(renamePath).toHaveBeenCalledWith("local", `${ROOT}/README.md`, "NOTES.md"));
    });

    it("cancels on Escape", async () => {
      const input = await startRename();
      fireEvent.change(input, { target: { value: "NOTES.md" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(renamePath).not.toHaveBeenCalled();
    });

    it("commits on blur", async () => {
      const input = await startRename();
      fireEvent.change(input, { target: { value: "NOTES.md" } });
      fireEvent.blur(input);
      await vi.waitFor(() => expect(renamePath).toHaveBeenCalledWith("local", `${ROOT}/README.md`, "NOTES.md"));
    });

    it("says what is wrong with a name in one short line", async () => {
      const input = await startRename();
      const line = () => input.parentElement?.parentElement?.querySelector("p")?.textContent;
      fireEvent.change(input, { target: { value: "src" } });
      expect(line()).toBe("src already exists here");
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(line()).toBe("Type a name");
      fireEvent.change(input, { target: { value: "/notes.md" } });
      expect(line()).toBe("A name can't start with a slash");
      fireEvent.change(input, { target: { value: "notes.md " } });
      expect(line()).toBe("The name starts or ends with a space");
    });
  });
});
