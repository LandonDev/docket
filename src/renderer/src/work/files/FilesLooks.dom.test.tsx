// @vitest-environment jsdom
/**
 * Proper viewing in the Files place (docs/DESIGN.md "The Files place"): thumbnails in Grid, Quick Look, Gallery,
 * Beside and its one seat, headings and the details pane, against a stand-in host that only records what it is
 * asked. The rule the walk tests hold: the arrow keys ask for pictures and nothing else.
 */
import { act, cleanup, configure, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePage } from "@shared/contract-work-files";
import type { FileEntry, FilePlace } from "@shared/work/files";
import type { WorkspaceMeta } from "../../lib/tcserver/types";

// The whole suite runs these beside a hundred other files: a wait for the screen is given room.
configure({ asyncUtilTimeout: 5000 });

const world = vi.hoisted(() => ({ calls: [] as { method: string; params: Record<string, unknown> }[], fail: {} as Record<string, string> }));
// The smallest PNG there is: what the stand-in host answers for every picture.
const PNG = "iVBORw0KGgo=";

vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({
    environmentId: id,
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls.push({ method, params });
      if (world.fail[method]) throw new Error(world.fail[method]);
      if (method === "work.files.thumbs") return { thumbs: (params.refs as { path: string }[]).map((ref) => (ref.path.endsWith(".txt") ? null : PNG)) };
      if (method === "work.files.preview") return (params.ref as { path: string }).path.endsWith(".bin") ? { none: "There is no preview of this file." } : { png: PNG, pages: (params.ref as { path: string }).path.endsWith(".pdf") ? 3 : 1, width: 640, height: 828 };
      if (method === "work.files.archive") return { entries: [{ name: "art/", size: 0, dir: true }, { name: "art/poster.png", size: 2048, dir: false }], more: false };
      if (method === "work.files.open") return { rev: 1, tabs: [], item: { id: "i1", sessionId: "filespane_w1", kind: "file", title: (params.name as string) ?? "File", source: params.ref, state: "open" } };
      return { rev: 1, tabs: [] };
    },
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: () => true, environment: (id: string) => ({ id, name: "The box", platform: "linux" }), environments: () => [], onLink: () => () => undefined } };
});
vi.mock("../canvas/CanvasPane", () => ({ CanvasPane: ({ item }: { item: { title: string } }) => <div data-testid="pane">{item.title}</div> }));

const { PageView } = await import("./Page");
const { forgetPictures } = await import("./previews");
const { keepPageLook, resetFilesStore } = await import("./store");

const at = (path: string) => ({ at: "file" as const, host: "env_box", path });
const PLACE = { id: "folder", kind: "folder", name: "Dummy Esports", host: "", env: "env_box", shared: false, can: [], state: { state: "ok" }, root: at("/w") } as unknown as FilePlace;
const COPY = { place: PLACE, link: "box", host: "The box", wire: "files" as const };
const PAGE: FilePage = { at: at("/w"), name: "Dummy Esports" };
const workspace = { id: "w1", environmentId: "box", path: "/w" } as unknown as WorkspaceMeta;
const file = (name: string, kind: FileEntry["kind"], over: Partial<FileEntry> = {}): FileEntry => ({ key: `file:env_box:/w/${name}`, ref: at(`/w/${name}`), folder: null, name, kind, changed: 1_700_000_000_000, size: 2048, ...over });
const FOLDER: FileEntry = { key: "file:env_box:/w/Events", ref: null, folder: at("/w/Events"), name: "Events", kind: "folder" };
const ENTRIES: FileEntry[] = [FOLDER, file("Budget.xlsx", "sheet"), file("Plan.pdf", "pdf"), file("notes.txt", "text"), file("Poster.png", "picture"), file("Cloud.docx", "document", { local: false, state: { is: "cloud" } }), file("data.bin", "other"), file("art.zip", "archive"), file("theme.mp3", "audio")];

function draw(over: Partial<Parameters<typeof PageView>[0]> = {}) {
  const opened: string[] = [];
  const fetched: string[] = [];
  const view = render(
    <PageView
      page={PAGE}
      panelId="p1"
      listing={{ entries: ENTRIES, trail: [{ name: "Dummy Esports", at: at("/w") }], loaded: true, more: false, loading: false, error: null, away: false, loadMore: () => undefined, retry: () => undefined }}
      copy={COPY}
      from={{ workspaceId: "w1", copy: COPY }}
      trail={[{ name: "Dummy Esports", at: at("/w") }]}
      canBack={false}
      canForward={false}
      busy={null}
      fixes={{ busy: false, run: () => undefined }}
      seat={{ workspace, can: (entry) => !!entry.ref }}
      onFetch={async (entry) => void fetched.push(entry.name)}
      onBack={() => undefined}
      onForward={() => undefined}
      onGo={() => undefined}
      onOpen={(entry) => void opened.push(entry.name)}
      {...over}
    />,
  );
  return { ...view, opened, fetched };
}
const asked = (method: string): Record<string, unknown>[] => world.calls.filter((call) => call.method === method).map((call) => call.params);
const row = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[data-files-row="file:env_box:/w/${name}"]`)!;
const list = (): HTMLElement => document.querySelector<HTMLElement>("[data-files-list], [data-files-grid], [data-files-strip]")!;

beforeEach(() => {
  world.calls = [];
  world.fail = {};
  localStorage.clear();
  resetFilesStore();
  forgetPictures();
});
afterEach(() => cleanup());

describe("thumbnails in Grid", () => {
  it("asks once for every tile a picture can be drawn of, never for a folder, a file kept in the cloud, a sound or an archive", async () => {
    keepPageLook(PAGE.at, { shape: "grid" });
    draw();
    await waitFor(() => expect(asked("work.files.thumbs")).toHaveLength(1));
    const ask = asked("work.files.thumbs")[0]!;
    expect((ask.refs as { path: string }[]).map((ref) => ref.path)).toEqual(["/w/Budget.xlsx", "/w/Plan.pdf", "/w/notes.txt", "/w/Poster.png"]);
    expect(ask.size).toBe(288);
    // A file with a picture shows it; one the host has none for keeps its kind's glyph.
    await waitFor(() => expect(row("Plan.pdf").querySelector("img")).not.toBeNull());
    expect(row("notes.txt").querySelector("img")).toBeNull();
    expect(row("notes.txt").querySelector("[data-kind-glyph='text']")).not.toBeNull();
    expect(row("Cloud.docx").querySelector("[data-kind-glyph='document']")).not.toBeNull();
  });

  it("asks again at the size of larger tiles, and keeps what it has when the folder is drawn again", async () => {
    keepPageLook(PAGE.at, { shape: "grid", tile: 208 });
    const first = draw();
    await waitFor(() => expect(asked("work.files.thumbs").map((a) => a.size)).toEqual([416]));
    await waitFor(() => expect(row("Plan.pdf").querySelector("img")).not.toBeNull());
    first.unmount();
    draw();
    expect(row("Plan.pdf").querySelector("img")).not.toBeNull();
    expect(asked("work.files.thumbs")).toHaveLength(1);
  });
});

describe("Quick Look", () => {
  it("opens on Space for the row the arrows rest on, follows the arrows, and closes on Space or Escape", async () => {
    draw();
    fireEvent.click(row("Plan.pdf"));
    fireEvent.keyDown(list(), { key: " " });
    const layer = screen.getByRole("dialog", { name: "Quick Look: Plan.pdf" });
    expect(layer).toBeTruthy();
    await waitFor(() => expect(layer.querySelector("img[alt='Plan.pdf, page 1']")).not.toBeNull());
    // A PDF of three pages: the first two at once.
    await waitFor(() => expect(asked("work.files.preview").map((a) => a.page)).toEqual([1, 2]));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(screen.getByRole("dialog", { name: "Quick Look: notes.txt" })).toBeTruthy();
    fireEvent.keyDown(list(), { key: " " });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(list(), { key: " " });
    fireEvent.keyDown(list(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Escape closed the look and left the selection as it was.
    expect(row("notes.txt").getAttribute("aria-selected")).toBe("true");
    // Nothing was opened, and nothing but pictures was asked for.
    expect(world.calls.every((call) => call.method === "work.files.preview")).toBe(true);
  });

  it("opens the file from its Open, and shows a file of no drawable kind as its facts with the host's sentence", async () => {
    const view = draw();
    fireEvent.click(row("data.bin"));
    fireEvent.keyDown(list(), { key: " " });
    const layer = screen.getByRole("dialog", { name: "Quick Look: data.bin" });
    expect(layer.textContent).toContain("File · 2 KB");
    expect(asked("work.files.preview")).toEqual([]);
    fireEvent.click(layer.querySelector("[data-files-quicklook-open]")!);
    expect(view.opened).toEqual(["data.bin"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("downloads nothing for a file kept in the cloud until Download and Look is pressed", async () => {
    const view = draw();
    fireEvent.click(row("Cloud.docx"));
    fireEvent.keyDown(list(), { key: " " });
    const layer = screen.getByRole("dialog", { name: "Quick Look: Cloud.docx" });
    expect(layer.textContent).toContain("It is kept in the cloud.");
    expect(world.calls).toEqual([]);
    await act(async () => void fireEvent.click(layer.querySelector("[data-files-fetch]")!));
    expect(view.fetched).toEqual(["Cloud.docx"]);
    await waitFor(() => expect(asked("work.files.preview")).toHaveLength(1));
  });

  it("lists what a zip holds and plays a sound only on a press", async () => {
    draw();
    fireEvent.click(row("art.zip"));
    fireEvent.keyDown(list(), { key: " " });
    await waitFor(() => expect(screen.getByRole("list", { name: "In this archive" }).textContent).toContain("art/poster.png"));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    const layer = screen.getByRole("dialog", { name: "Quick Look: theme.mp3" });
    expect(layer.querySelector("[data-files-play]")).not.toBeNull();
    expect(asked("work.files.read")).toEqual([]);
  });
});

describe("Gallery", () => {
  it("shows the first thing of the folder large, walks with the arrows over a strip of small pictures, and opens on Return", async () => {
    keepPageLook(PAGE.at, { shape: "gallery" });
    const view = draw();
    expect(document.querySelector("[data-files-preview]")!.getAttribute("data-files-preview")).toBe(FOLDER.key);
    const strip = document.querySelector<HTMLElement>("[data-files-strip]")!;
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(document.querySelector("[data-files-preview]")!.getAttribute("data-files-preview")).toBe("file:env_box:/w/Plan.pdf");
    await waitFor(() => expect(document.querySelector("img[alt='Plan.pdf, page 1']")).not.toBeNull());
    await waitFor(() => expect(asked("work.files.thumbs")).toHaveLength(1));
    expect(asked("work.files.thumbs")[0]!.size).toBe(192);
    fireEvent.keyDown(strip, { key: "Enter" });
    expect(view.opened).toEqual(["Plan.pdf"]);
    expect(world.calls.every((call) => call.method === "work.files.preview" || call.method === "work.files.thumbs")).toBe(true);
  });
});

describe("Beside", () => {
  it("shows a read-only preview a moment after the arrows rest, and a walk writes nothing to the host", async () => {
    keepPageLook(PAGE.at, { shape: "beside" });
    draw();
    const rows = list();
    for (let i = 0; i < 4; i++) fireEvent.keyDown(rows, { key: "ArrowDown" });
    // The walk passed three files in one breath: only the one it rests on is looked at.
    await waitFor(() => expect(document.querySelector("[data-files-preview]")?.getAttribute("data-files-preview")).toBe("file:env_box:/w/notes.txt"));
    await waitFor(() => expect(asked("work.files.preview")).toHaveLength(1));
    expect((asked("work.files.preview")[0]!.ref as { path: string }).path).toBe("/w/notes.txt");
    expect(world.calls.map((call) => call.method)).toEqual(["work.files.preview"]);
    expect(screen.queryByTestId("pane")).toBeNull();
  });

  it("opens the file as itself in the window's one seat on a click into the right half, back to a preview when the list moves, and lets the seat go when Beside is left", async () => {
    keepPageLook(PAGE.at, { shape: "beside" });
    const view = draw();
    fireEvent.click(row("notes.txt"));
    await waitFor(() => expect(document.querySelector("[data-files-preview]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-files-beside-look]")!);
    await waitFor(() => expect(screen.getByTestId("pane").textContent).toBe("notes.txt"));
    const open = asked("work.files.open")[0]!;
    expect(open).toMatchObject({ workspaceId: "w1", name: "notes.txt", ref: at("/w/notes.txt") });
    expect(typeof open.beside).toBe("string");
    // The arrows move on: the right half is a preview again, and nothing more is opened.
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    await waitFor(() => expect(screen.queryByTestId("pane")).toBeNull());
    expect(asked("work.files.open")).toHaveLength(1);
    view.unmount();
    expect(asked("work.files.tabClose")).toEqual([{ workspaceId: "w1", tabId: `seat:${open.beside as string}` }]);
  });

  it("never seats a file kept in the cloud, and lets go of no seat it never took", async () => {
    keepPageLook(PAGE.at, { shape: "beside" });
    const view = draw();
    fireEvent.click(row("Cloud.docx"));
    await waitFor(() => expect(document.querySelector("[data-files-fetch]")?.textContent).toBe("Download and Open"));
    fireEvent.click(document.querySelector("[data-files-beside-look]")!);
    expect(asked("work.files.open")).toEqual([]);
    view.unmount();
    expect(asked("work.files.tabClose")).toEqual([]);
  });
});

describe("headings and details", () => {
  it("draws the list under a heading a kind, folders first, and walks the rows in that order", () => {
    keepPageLook(PAGE.at, { group: "kind" });
    draw();
    expect([...document.querySelectorAll("[data-files-group]")].map((el) => el.textContent)).toEqual(["Folders", "Archives", "Audio", "Documents", "Other files", "PDFs", "Pictures", "Sheets", "Text"]);
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(row("art.zip").getAttribute("aria-selected")).toBe("true");
  });

  it("shows the selected file's picture and facts beside the list when Show Details is on", async () => {
    keepPageLook(PAGE.at, { details: true });
    draw();
    expect(document.querySelector("[data-files-details]")!.textContent).toBe("Select a file to see it here.");
    fireEvent.click(row("Plan.pdf"));
    const pane = document.querySelector<HTMLElement>("[data-files-details]")!;
    expect(pane.textContent).toContain("Plan.pdf");
    expect(pane.textContent).toContain("KindPDF");
    await waitFor(() => expect(pane.querySelector("img")).not.toBeNull());
    expect(asked("work.files.thumbs")[0]!.size).toBe(416);
  });
});

describe("a drag that can leave the window", () => {
  const place = { ...PLACE, can: ["move", "copy", "upload"] } as unknown as FilePlace;
  const stub = (over: Record<string, unknown>) =>
    ({ place, from: { ...COPY, place }, tabs: true, make: async () => null, rename: async () => null, carry: () => undefined, trash: () => undefined, restore: () => undefined, purge: () => undefined, star: () => undefined, openTab: () => undefined, openApp: () => undefined, pickUpload: () => undefined, upload: () => undefined, drop: () => undefined, uploading: null, cancelUpload: () => undefined, ...over }) as never;

  it("hands files that lie on this computer to the system, and a drop on a folder of the page is still a move of those rows, never an upload", async () => {
    let ended: () => void = () => undefined;
    const out: string[][] = [];
    const dropped: { verb: string; names: string[]; into: string }[] = [];
    const uploaded: unknown[] = [];
    draw({
      acts: stub({
        dragOut: (rows: FileEntry[]) => (out.push(rows.map((e) => e.name)), new Promise<void>((done) => (ended = done))),
        drop: (verb: string, rows: FileEntry[], into: FileEntry) => void dropped.push({ verb, names: rows.map((e) => e.name), into: into.name }),
        upload: (files: unknown) => void uploaded.push(files),
      }),
    });
    const start = createEvent.dragStart(row("Plan.pdf"), { dataTransfer: { setData: () => undefined, types: [] } });
    fireEvent(row("Plan.pdf"), start);
    // The window's own drag is given up for the system's: it carries the file.
    expect(start.defaultPrevented).toBe(true);
    expect(out).toEqual([["Plan.pdf"]]);
    const folder = document.querySelector<HTMLElement>(`[data-files-row="${FOLDER.key}"]`)!;
    const types = { types: ["Files"], files: [], dropEffect: "none" };
    const over = createEvent.dragOver(folder, { dataTransfer: types });
    fireEvent(folder, over);
    expect(over.defaultPrevented).toBe(true);
    fireEvent.drop(folder, { dataTransfer: types });
    expect(dropped).toEqual([{ verb: "move", names: ["Plan.pdf"], into: "Events" }]);
    expect(uploaded).toEqual([]);
    await act(async () => ended());
  });

  it("keeps the drag in the window where a row cannot go out, and reads a desktop's files as an upload when nothing of ours is dragged", () => {
    const uploaded: string[] = [];
    draw({ acts: stub({ dragOut: () => null, upload: (files: File[], into?: FileEntry) => void uploaded.push(`${files.length} into ${into?.name ?? "here"}`) }) });
    const set: string[] = [];
    const start = createEvent.dragStart(row("Cloud.docx"), { dataTransfer: { setData: (type: string) => void set.push(type), types: [] } });
    fireEvent(row("Cloud.docx"), start);
    expect(start.defaultPrevented).toBe(false);
    expect(set).toEqual(["application/x-tempcode-files-rows"]);
    fireEvent.dragEnd(row("Cloud.docx"));
    const folder = document.querySelector<HTMLElement>(`[data-files-row="${FOLDER.key}"]`)!;
    fireEvent.drop(folder, { dataTransfer: { types: ["Files"], files: [new File(["x"], "a.txt")] } });
    expect(uploaded).toEqual(["1 into Events"]);
  });
});
