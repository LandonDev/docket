// @vitest-environment jsdom
/**
 * Save As… (docs/agents/work-files.md "Save As…"): a document's Files tab has it in its header and its ⋯, a text file's
 * does not; the sheet's formats are the host's own, a press walks into a folder, Save asks the workspace's host to save
 * and link the file there, a file of that name asks Replace or Keep Both, Just a copy links nothing and says where with
 * Show; the header then says where the linked file is and how it stands, with its presses in one menu.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTab } from "@shared/contract-work-files";
import type { CanvasItem } from "@shared/work";
import type { FilePlace } from "@shared/work/files";
import type { WorkspaceMeta } from "../../lib/tcserver/types";

const world = vi.hoisted(() => ({ fail: 0, refuse: null as string | null, calls: [] as { method: string; params: Record<string, unknown> }[], toasts: [] as { title: string; show?: () => void }[], opened: [] as unknown[], exists: false, choice: "other" as "action" | "other" | null, links: [] as unknown[], acting: null as null | Promise<unknown>, push: null as null | ((push: Record<string, unknown>) => void) }));

const at = (path: string) => ({ at: "file" as const, host: "env_box", path });
const place = (id: string, kind: string, name: string, root: string, can: string[] = ["make"]): FilePlace => ({ id, kind, name, host: "The box", env: "env_box", shared: kind !== "folder", can, makes: ["folder"], state: { state: "ok" }, root: at(root) }) as unknown as FilePlace;

vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({
    environmentId: id,
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls.push({ method, params });
      if (method === "work.files.places")
        return { places: [place("folder", "folder", "Dummy Esports", "/w"), { ...place("b1", "teams", "General", "/cloud/General"), group: "Esports Staff", key: "general" }], sources: [] };
      if (method === "work.files.list") return { entries: [], trail: [{ name: "General", at: at("/cloud/General") }] };
      if (method === "work.files.saveAs") {
        if (world.fail > 0 && world.fail--) throw new Error("The request timed out.");
        if (world.refuse) {
          const why = world.refuse;
          world.refuse = null;
          throw new Error(why);
        }
        if (world.exists && !params.exists) return { exists: { name: params.name, version: "v-there" } };
        return { saved: { name: params.name, ref: at(`/cloud/General/${String(params.name)}`), linked: params.link !== false } };
      }
      if (method === "work.files.linkAct" && world.acting) return world.acting;
      if (method === "work.files.links" || method === "work.files.linkAct") return world.links;
      if (method === "work.files.preview") return { none: "There is no preview here." };
      if (method === "work.office.filesCopyGet") return { on: false };
      if (method === "work.files.wordSave") return { at: 1 };
      throw new Error(`unexpected ${method}`);
    },
    onPush: (fn: (push: Record<string, unknown>) => void) => ((world.push = fn), () => undefined),
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: (id: string) => id !== "desk", environment: () => ({ name: "The box" }), environments: () => [], onLink: () => () => undefined, statusOf: () => ({ transport: "open" }) } };
});
vi.mock("../shell/actions", () => ({ workspaceSettings: async () => ({ mayUseDesktop: [], windowsVm: false }), localHostId: async () => null, windowDesktops: async () => [], linkIdOfHost: () => "box" }));
vi.mock("../canvas/CanvasPane", () => ({ CanvasPane: () => <div data-testid="pane" /> , useKindModule: () => null }));
vi.mock("../../components/ui/toaster", async (original) => ({
  ...(await original<typeof import("../../components/ui/toaster")>()),
  loadToast: async () => ({
    message: (title: string, o: { action?: { onClick(): void } } = {}) => void world.toasts.push({ title, ...(o.action ? { show: o.action.onClick } : {}) }),
    error: (title: string) => void world.toasts.push({ title }),
  }),
}));
const META = { id: "w1", environmentId: "box", path: "/w", name: "Dummy Esports", kind: "work" } as WorkspaceMeta;
vi.mock("./workspaceOf", () => ({ useWorkspaceOf: () => META }));
vi.mock("./openFrom", () => ({ openInFiles: async (_w: unknown, what: unknown) => void world.opened.push(what) }));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({ ...(await original<typeof import("../../chrome/ConfirmDialog")>()), confirmChoice: async () => world.choice }));

const { FileTabView } = await import("./FileTabView");
const { SaveAsDialog } = await import("./SaveAs");
const { DocSaveControls } = await import("./DocLinks");
const port = await import("./saveAsPort");
const { SAVE_AS_FORMATS } = await import("@shared/work/saveAs");

const item = (kind: CanvasItem["kind"], path: string, title: string): CanvasItem =>
  ({ id: "i1", sessionId: "filespane_w1", workspaceId: "w1", kind, title, source: { at: "file", host: "env_box", path }, state: "open", position: 0, rev: 0, createdAt: 1, updatedAt: 1 }) as CanvasItem;
const tab = (name: string): FileTab => ({ id: "t1", kind: "file", name, itemId: "i1", key: name });
const show = (kind: CanvasItem["kind"], name: string, title: string) =>
  render(<FileTabView tab={tab(name)} item={item(kind, `/w/${name}`, title)} panelId="p" workspace={META} where="Dummy Esports" copy={null} onClose={() => undefined} />);
const header = (): HTMLElement => document.querySelector("[data-files-header]") as HTMLElement;
const openMenu = async (name: string): Promise<HTMLElement> => {
  fireEvent.click(within(header()).getByRole("button", { name: `More for ${name}` }));
  return screen.findByRole("menu");
};
const DOC = { at: "file" as const, host: "env_box", path: "/w/Run of show.tcdoc" };
const sheet = async (format: "docx" | "pdf" | null = null) => {
  render(<SaveAsDialog workspace={META} source={DOC} title="Run of show" itemId="i1" format={format} />);
  return screen.findByRole("dialog", { name: "Save As" });
};
/** Walks from the places into the team's General. */
const intoGeneral = async (dialog: HTMLElement): Promise<void> => {
  fireEvent.click(await within(dialog).findByRole("option", { name: "General" }));
  await within(dialog).findByRole("listbox", { name: "Folders in Esports Staff, General" });
};
/** Which document's sheet is asked for, as the document's body reads it. */
function Probe() {
  const ask = port.useSaveAsAsk("i1");
  return <i data-testid="ask">{ask ? `${ask.itemId}:${ask.format ?? "last"}` : ""}</i>;
}
const saved = () => world.calls.filter((c) => c.method === "work.files.saveAs").map((c) => c.params);

beforeEach(() => {
  world.calls.length = 0;
  world.toasts.length = 0;
  world.opened.length = 0;
  world.exists = false;
  world.fail = 0;
  world.refuse = null;
  port.tellOrigin("i1", null);
  world.choice = "other";
  world.links = [];
  localStorage.clear();
  port.closeSaveAs();
});
afterEach(cleanup);

describe("Save As… in a Files tab", () => {
  it("is a row of a document's ⋯ and of no text file's; its button is the document bar's alone, never twice", async () => {
    show("file", "Notes.md", "Notes.md");
    expect(within(await openMenu("Notes.md")).queryByRole("menuitem", { name: "Save As…" })).toBeNull();
    cleanup();
    show("document", "Run of show.tcdoc", "Run of show");
    // The tab's header holds no second Save As…: the document's bar under it draws the button and the linked files.
    expect(within(header()).queryByRole("button", { name: "Save As…" })).toBeNull();
    render(<Probe />);
    fireEvent.click(within(await openMenu("Run of show.tcdoc")).getByRole("menuitem", { name: "Save As…" }));
    // The document's body draws the sheet for the item asked.
    await waitFor(() => expect(screen.getByTestId("ask").textContent).toBe("i1:last"));
  });
});

describe("Save as Template… in a Files tab", () => {
  it("is a row of a file the shelf can keep, and asks the Templates dialog for that file; a text file and a copy have none", async () => {
    const { workTemplatePort } = await import("../templates/open");
    const asked: unknown[] = [];
    workTemplatePort.set({ open: () => undefined, save: (ask) => void asked.push(ask) });
    try {
      show("file", "Notes.md", "Notes.md");
      expect(within(await openMenu("Notes.md")).queryByRole("menuitem", { name: "Save as Template…" })).toBeNull();
      cleanup();
      // A copy of a file from another computer: its file is not on this host, so the shelf cannot copy it.
      render(<FileTabView tab={tab("Agenda.docx")} item={item("document", "/scratch/Agenda.docx", "Agenda")} panelId="p" workspace={META} where="General" copy={{ host: "Mac", place: "General" } as never} onClose={() => undefined} />);
      expect(within(await openMenu("Agenda.docx")).queryByRole("menuitem", { name: "Save as Template…" })).toBeNull();
      cleanup();
      show("document", "Agenda.docx", "Agenda");
      fireEvent.click(within(await openMenu("Agenda.docx")).getByRole("menuitem", { name: "Save as Template…" }));
      expect(asked).toEqual([{ workspaceId: "w1", source: { at: "file", host: "env_box", path: "/w/Agenda.docx" } }]);
      cleanup();
      // A Word file opened as the document made of it: the tab wears the document's name, the file is still one the shelf keeps.
      render(<FileTabView tab={tab("Agenda")} item={item("document", "/w/Agenda.tcdoc", "Agenda")} panelId="p" workspace={META} where="Dummy Esports" copy={null} onClose={() => undefined} />);
      expect(within(await openMenu("Agenda")).getByRole("menuitem", { name: "Save as Template…" })).toBeTruthy();
    } finally {
      workTemplatePort.set(null);
    }
  });
});

describe("the Save As… sheet", () => {
  it("offers the host's own formats and Word first, opens on the places, and offers no Save until a folder is picked", async () => {
    const dialog = await sheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "Word" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemcheckbox").map((r) => r.textContent?.replace(/\.\w+$/, ""))).toEqual(SAVE_AS_FORMATS.map((f) => f.label));
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["Dummy Esports", "General"]));
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText("Pick a folder")).toBeTruthy();
    // The page the host could not draw is the format's glyph, never the host's sentence alone in the pane.
    await waitFor(() => expect(dialog.querySelector('.size-8[data-kind-glyph="document"]')).not.toBeNull());
    expect(within(dialog).queryByText("There is no preview here.")).toBeNull();
    // The line of where it lands takes the free room beside Cancel and Save, and is cut there: the verbs stay on one line.
    expect(dialog.querySelector<HTMLElement>("[data-footer-start]")!.className.split(" ")).toEqual(expect.arrayContaining(["flex-1", "basis-0", "min-w-0"]));
  });

  it("saves and links the document in the folder he walked into, and says so in one line before he presses", async () => {
    const dialog = await sheet();
    await intoGeneral(dialog);
    expect(within(dialog).getByText("Saves Run of show.docx in Esports Staff, General, kept up to date")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({ workspaceId: "w1", source: DOC, at: at("/cloud/General"), name: "Run of show.docx", format: "docx", link: true, place: "Esports Staff, General" });
    // A linked file is said by the header, not by a toast.
    await new Promise((r) => setTimeout(r, 20));
    expect(world.toasts).toEqual([]);
  });

  it("asks Replace or Keep Both over a file of that name, and never writes over it unasked", async () => {
    world.exists = true;
    world.choice = "other";
    const dialog = await sheet("pdf");
    await intoGeneral(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(2));
    expect(saved()[0]!.exists).toBeUndefined();
    expect(saved()[1]).toMatchObject({ name: "Run of show.pdf", format: "pdf", exists: "keep" });
  });

  it("sends Replace with the version its question named", async () => {
    world.exists = true;
    world.choice = "action";
    const dialog = await sheet();
    await intoGeneral(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(2));
    expect(saved()[1]).toMatchObject({ exists: "replace", version: "v-there" });
  });

  it("Just a copy links nothing, and says where it went with Show", async () => {
    const dialog = await sheet();
    await intoGeneral(dialog);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(within(dialog).getByText("Saves a copy of Run of show.docx in Esports Staff, General")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(world.toasts).toHaveLength(1));
    expect(saved()[0]).toMatchObject({ link: false });
    expect(world.toasts[0]!.title).toBe("Saved a copy of Run of show.docx in Esports Staff, General");
    world.toasts[0]!.show!();
    expect(world.opened).toEqual([{ page: { at: at("/cloud/General"), name: "Esports Staff, General" } }]);
  });

  it("of a LifeOS document says the file is a copy made once and sends no link: nothing could keep it up to date", async () => {
    render(<SaveAsDialog workspace={META} source={{ at: "lifeos", table: "docs", id: "d1" }} title="Run of show" itemId="i1" format={null} />);
    const dialog = await screen.findByRole("dialog", { name: "Save As" });
    await intoGeneral(dialog);
    expect(within(dialog).getByText("Saves a copy of Run of show.docx in Esports Staff, General")).toBeTruthy();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({ link: false });
  });

  it("opens next time in the folder he saved to last, under Recent", async () => {
    let dialog = await sheet();
    await intoGeneral(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    cleanup();
    dialog = await sheet();
    expect(await within(dialog).findByRole("listbox", { name: "Folders in Esports Staff, General" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Places" }));
    expect(within(dialog).getByText("Recent")).toBeTruthy();
  });
});

describe("the sheet for a document made of a file", () => {
  const general = { place: { ...place("b1", "teams", "General", "/cloud/General"), group: "Esports Staff", key: "general" } as FilePlace, link: "box", host: "The box", wire: "files" as const };
  const fromFile = (name: string) => port.tellOrigin("i1", { folder: { copy: general, at: at("/cloud/General"), name: "General", where: "Esports Staff, General" }, name });

  it("opens in the folder the file lies in, in that file's own format", async () => {
    fromFile("Budget.odt");
    const dialog = await sheet();
    expect(await within(dialog).findByRole("listbox", { name: "Folders in General" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "OpenDocument" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "New Folder" })).toBeTruthy();
  });

  it("names the far computer where a folder can be made and keeps Save available", async () => {
    port.tellOrigin("i1", { folder: { copy: { ...general, link: "desk", host: "Desk PC" }, at: at("/cloud/General"), name: "General", where: "General" }, name: "Budget.docx" });
    const dialog = await sheet();
    expect(within(dialog).getByText("Make folders on Desk PC.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "New Folder" })).toBeNull();
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    expect(world.calls.some((c) => c.method === "work.files.make")).toBe(false);
  });

  it("leaves New Folder out when the connected place does not offer folders", async () => {
    const copy = { ...general, place: { ...general.place, makes: ["text" as const] } };
    port.tellOrigin("i1", { folder: { copy, at: at("/cloud/General"), name: "General", where: "General" }, name: "Budget.docx" });
    const dialog = await sheet();
    expect(within(dialog).queryByRole("button", { name: "New Folder" })).toBeNull();
  });

  it("saves a .doc as Word, and says its copy is a .docx", async () => {
    fromFile("Practice register.doc");
    const dialog = await sheet();
    expect(within(dialog).getByRole("button", { name: "Word" })).toBeTruthy();
    expect(within(dialog).getByText("A .doc is saved as .docx")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({ at: at("/cloud/General"), format: "docx", name: "Run of show.docx" });
  });

  it("never offers the file's own path: a document of Run of show.docx starts as Run of show copy", async () => {
    fromFile("Run of show.docx");
    const dialog = await sheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({ at: at("/cloud/General"), format: "docx", name: "Run of show copy.docx" });
  });

  it("sends Save again after a refusal the holder confirmed as a new press, so the cause he cleared is tried again", async () => {
    fromFile("Budget.docx");
    world.refuse = "This workspace keeps Teams files where they are.";
    const dialog = await sheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(world.toasts.map((t) => t.title)).toEqual(["Not saved"]));
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(2));
    expect(saved()[1]!.op).not.toBe(saved()[0]!.op);
  });

  it("sends Save again after a failure as the same press, so a file it made is answered, never made twice", async () => {
    fromFile("Budget.docx");
    world.fail = 1;
    const dialog = await sheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(world.toasts.map((t) => t.title)).toEqual(["Not saved"]));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(2));
    expect(saved()[1]!.op).toBe(saved()[0]!.op);
    // Once saved, the next Save is another press.
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toHaveLength(3));
    expect(saved()[2]!.op).not.toBe(saved()[0]!.op);
  });
});

describe("the header's linked files", () => {
  const link = (over: Record<string, unknown> = {}) => ({ id: "l1", name: "Run of show.docx", format: "docx", place: "General", ref: at("/cloud/General/Run of show.docx"), folder: at("/cloud/General"), state: "saved", at: new Date(2026, 10, 24, 21, 12).getTime(), ...over });
  const controls = () => render(<DocSaveControls workspace={META} source={DOC} itemId="i1" />);

  it("says where the first is and how it stands, with a count of the rest, and Save As… beside it", async () => {
    world.links = [link(), link({ id: "l2", name: "Run of show.pdf", format: "pdf", place: "Dummy Esports", state: "saving" })];
    controls();
    const button = await screen.findByRole("button", { name: /Saved to General 9:12 PM/ });
    expect(button.textContent).toContain("+1");
    expect(button.className).toContain("text-muted-foreground");
    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    expect(screen.getByTestId("ask").textContent).toBe("i1:last");
  });

  it("gives Save As… way whole in the narrow bar beside a thread, Share kept: it stays in the header's More", () => {
    world.links = [];
    controls();
    // The kind's bar hides `data-narrow-hide` tools under 560px (KindBar.tsx TOOLS_NARROW); the document's Share is not one.
    expect(screen.getByRole("button", { name: "Save As…" }).hasAttribute("data-narrow-hide")).toBe(true);
  });

  it("takes the foreground when a Word file changed there, and offers Keep Both and Replace; Unlink stops it", async () => {
    world.links = [link({ state: "changed", changedAt: 1 })];
    controls();
    const button = await screen.findByRole("button", { name: /Changed in General/ });
    expect(button.className).toContain("text-foreground");
    fireEvent.click(button);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((r) => r.textContent)).toEqual(["Keep Both", "Replace", "Open", "Show in Files", "Unlink"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unlink" }));
    await waitFor(() => expect(world.calls.find((c) => c.method === "work.files.linkAct")?.params).toMatchObject({ id: "l1", act: "unlink" }));
  });

  it("says a save's upload only once it has lasted 600 ms, keeping what it said before until then", async () => {
    world.links = [link()];
    controls();
    await screen.findByRole("button", { name: /Saved to General 9:12 PM/ });
    world.links = [link({ upload: "uploading", at: new Date(2026, 10, 24, 21, 20).getTime() })];
    await act(async () => world.push?.({ push: "work.files", workspaceId: "w1", tabs: 2 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("button", { name: /Saved to General 9:12 PM/ })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Saved, uploading to General/ }, { timeout: 1500 })).toBeTruthy();
  });

  it("reads out the link's words only when it needs him, never at each save", async () => {
    world.links = [link()];
    const saved = controls();
    await screen.findByRole("button", { name: /Saved to General 9:12 PM/ });
    expect(saved.container.querySelector("[aria-live]")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
    saved.unmount();
    world.links = [link({ state: "changed", changedAt: 1 })];
    controls();
    await screen.findByRole("button", { name: /Changed in General/ });
    expect(screen.getByRole("status").textContent).toMatch(/Changed in General/);
  });

  it("sends Replace with the version the link showed changed", async () => {
    world.links = [link({ state: "changed", changedAt: 1, version: "v-there" })];
    controls();
    fireEvent.click(await screen.findByRole("button", { name: /Changed in General/ }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Replace" }));
    await waitFor(() => expect(world.calls.find((c) => c.method === "work.files.linkAct")?.params).toMatchObject({ id: "l1", act: "replace", version: "v-there" }));
  });

  it("offers Save Again for a PDF changed or deleted there, and Retry for a place that did not answer", async () => {
    world.links = [link({ format: "pdf", name: "Run of show.pdf", state: "gone" }), link({ id: "l2", state: "waiting" })];
    controls();
    fireEvent.click(await screen.findByRole("button", { name: /Moved or deleted in General/ }));
    const rows = within(await screen.findByRole("menu")).getAllByRole("menuitem").map((r) => r.textContent);
    expect(rows).toContain("Save Again");
    expect(rows).toContain("Retry");
  });

  it("keeps the menu open on Retry, spinning in its row alone until the answer replaces it", async () => {
    world.links = [link({ state: "waiting" })];
    let answer: (links: unknown[]) => void = () => undefined;
    world.acting = new Promise((resolve) => (answer = resolve));
    controls();
    fireEvent.click(await screen.findByRole("button", { name: /General/ }));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Retry" }));
    await waitFor(() => expect(world.calls.find((c) => c.method === "work.files.linkAct")?.params).toMatchObject({ id: "l1", act: "retry" }));
    const retry = within(screen.getByRole("menu")).getByRole("menuitem", { name: "Retry" });
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Unlink" }).getAttribute("aria-busy")).toBeNull();
    await act(async () => answer([link()]));
    await waitFor(() => expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Retry" })).toBeNull());
    world.acting = null;
  });
});

describe("⌘S on a Word file of another computer", () => {
  const wordTab = (word: FileTab["word"]): FileTab => ({ ...tab("Agenda.docx"), copyOf: { host: "env_mac", path: "/Teams/General/Agenda.docx" }, word }) as FileTab;
  const press = async (): Promise<void> => {
    const { saveFocused } = await import("../../lib/saveKey");
    await saveFocused({ closest: () => ({ getAttribute: () => "i1" }) });
  };
  const wordSaves = () => world.calls.filter((c) => c.method === "work.files.wordSave").map((c) => c.params);

  it("that saves by itself writes the Word file at once, never waiting for Word's pause", async () => {
    render(<FileTabView tab={wordTab({ since: true, auto: true, at: 1 })} item={item("document", "/w/Agenda.tcdoc", "Agenda")} panelId="p" workspace={META} where="General" copy={{ host: "MacBook", place: "General" } as never} onClose={() => undefined} />);
    await press();
    await waitFor(() => expect(wordSaves()).toEqual([{ workspaceId: "w1", tabId: "t1", auto: true }]));
  });

  it("that waits for his press writes nothing, and says so", async () => {
    render(<FileTabView tab={wordTab({ since: true, auto: false })} item={item("document", "/w/Agenda.tcdoc", "Agenda")} panelId="p" workspace={META} where="General" copy={{ host: "MacBook", place: "General" } as never} onClose={() => undefined} />);
    await press();
    await waitFor(() => expect(world.toasts.map((t) => t.title)).toEqual(["Agenda.docx changes when you press Save to Teams."]));
    expect(wordSaves()).toEqual([]);
  });
});
