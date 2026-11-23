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
      // A text file's bytes; a file of no known kind holds a NUL, so it is no text.
      if (method === "work.files.read") return (params.ref as { path: string }).path.endsWith(".txt") ? { data: btoa("Practice starts at 4 PM.\nBring the bracket."), end: true, size: 42, version: "v1", changed: 1 } : { data: btoa("\u0000\u0001bin"), end: true, size: 5, version: "v1", changed: 1 };
      if (method === "work.files.list") return { entries: [], place: "folder", trail: [] };
      if (method === "work.files.stat") return { entries: (params.refs as unknown[]).map(() => null) };
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
const { keepPageLook, listingSeams, resetFilesStore } = await import("./store");

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

/** An IntersectionObserver that sees every element it is given at once, as a window whose grid shows it all. */
class SeesAll {
  constructor(private readonly heard: IntersectionObserverCallback) {}
  observe(target: Element): void {
    queueMicrotask(() => this.heard([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", SeesAll);
  world.calls = [];
  world.fail = {};
  localStorage.clear();
  resetFilesStore();
  forgetPictures();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
    // Nothing was opened, and nothing but pictures and a text file's first lines was asked for.
    expect(world.calls.every((call) => call.method === "work.files.preview" || call.method === "work.files.read")).toBe(true);
  });

  it("opens the file from its Open, and shows a file of no drawable kind as its facts with the host's sentence", async () => {
    const view = draw();
    fireEvent.click(row("data.bin"));
    fireEvent.keyDown(list(), { key: " " });
    const layer = screen.getByRole("dialog", { name: "Quick Look: data.bin" });
    expect(layer.textContent).toContain("File, 2 KB, changed");
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
    // A text file is looked at as its first lines: read, never opened or written.
    await waitFor(() => expect(asked("work.files.read")).toHaveLength(1));
    expect((asked("work.files.read")[0]!.ref as { path: string }).path).toBe("/w/notes.txt");
    expect(world.calls.map((call) => call.method)).toEqual(["work.files.read"]);
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
    // With nothing selected the pane stands empty: no sentence explains it.
    expect(document.querySelector("[data-files-details]")!.textContent).toBe("");
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

  it("on a Mac, where the system's drag is under way when the call that starts it answers, a drop on a folder is still a move, and the rows are let go once the pointer is seen with no button held", async () => {
    const dropped: { verb: string; names: string[]; into: string }[] = [];
    const uploaded: string[] = [];
    draw({
      acts: stub({
        dragOut: () => Promise.resolve(),
        drop: (verb: string, rows: FileEntry[], into: FileEntry) => void dropped.push({ verb, names: rows.map((e) => e.name), into: into.name }),
        upload: (files: File[], into?: FileEntry) => void uploaded.push(`${files.length} into ${into?.name ?? "here"}`),
      }),
    });
    fireEvent(row("Plan.pdf"), createEvent.dragStart(row("Plan.pdf"), { dataTransfer: { setData: () => undefined, types: [] } }));
    // The call has answered; the drag goes on.
    await act(async () => undefined);
    const folder = document.querySelector<HTMLElement>(`[data-files-row="${FOLDER.key}"]`)!;
    const carried = { types: ["Files"], files: [new File(["x"], "Plan.pdf")], dropEffect: "none" };
    fireEvent.drop(folder, { dataTransfer: carried });
    expect(dropped).toEqual([{ verb: "move", names: ["Plan.pdf"], into: "Events" }]);
    expect(uploaded).toEqual([]);
    // A second drag, let go on the desktop: nothing tells the window, until the pointer is back with no button held.
    fireEvent(row("Plan.pdf"), createEvent.dragStart(row("Plan.pdf"), { dataTransfer: { setData: () => undefined, types: [] } }));
    await act(async () => undefined);
    fireEvent.mouseMove(document.body, { buttons: 0 });
    await act(async () => void (await new Promise((done) => setTimeout(done, 5))));
    // What comes from the desktop after that is an upload again.
    fireEvent.drop(folder, { dataTransfer: { types: ["Files"], files: [new File(["x"], "a.txt")] } });
    expect(uploaded).toEqual(["1 into Events"]);
    expect(dropped).toHaveLength(1);
  });

  it("keeps the rows when the drag leaves the window and comes back still held: a drop on a folder then still moves them", async () => {
    const dropped: string[] = [];
    const uploaded: string[] = [];
    draw({
      acts: stub({
        dragOut: () => Promise.resolve(),
        drop: (verb: string, rows: FileEntry[], into: FileEntry) => void dropped.push(`${verb} ${rows.map((e) => e.name).join()} into ${into.name}`),
        upload: (files: File[], into?: FileEntry) => void uploaded.push(`${files[0]!.name} into ${into?.name ?? "here"}`),
      }),
    });
    const folder = document.querySelector<HTMLElement>(`[data-files-row="${FOLDER.key}"]`)!;
    const wait = (): Promise<void> => act(async () => void (await new Promise((done) => setTimeout(done, 5))));
    // jsdom's drag events take no related target from their init: it is set on the event itself.
    const cross = (type: "dragEnter" | "dragLeave", el: HTMLElement, related: HTMLElement | null): void => {
      const event = createEvent[type](el, { dataTransfer: { types: ["Files"] } });
      Object.defineProperty(event, "relatedTarget", { value: related });
      fireEvent(el, event);
    };
    fireEvent(row("Plan.pdf"), createEvent.dragStart(row("Plan.pdf"), { dataTransfer: { setData: () => undefined, types: [] } }));
    await act(async () => undefined);
    // Over the window's edge and back, the button still held.
    cross("dragLeave", folder, null);
    cross("dragEnter", folder, null);
    await wait();
    fireEvent.drop(folder, { dataTransfer: { types: ["Files"], files: [new File(["x"], "Plan.pdf")] } });
    expect(dropped).toEqual(["move Plan.pdf into Events"]);
    expect(uploaded).toEqual([]);
  });

  it("lets the rows go when the window loses focus after a drag out, as a press in Finder does", async () => {
    const uploaded: string[] = [];
    draw({ acts: stub({ dragOut: () => Promise.resolve(), upload: (files: File[]) => void uploaded.push(files[0]!.name) }) });
    fireEvent(row("Plan.pdf"), createEvent.dragStart(row("Plan.pdf"), { dataTransfer: { setData: () => undefined, types: [] } }));
    await act(async () => undefined);
    fireEvent.blur(window);
    await act(async () => void (await new Promise((done) => setTimeout(done, 5))));
    const body = document.querySelector<HTMLElement>("[data-files-body]")!;
    fireEvent.drop(body, { dataTransfer: { types: ["Files"], files: [new File(["x"], "Finder.pdf")] } });
    expect(uploaded).toEqual(["Finder.pdf"]);
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

describe("after the council's first round", () => {
  /** An IntersectionObserver this test drives: it says an element is near only when told. */
  const watched: { el: Element; heard: IntersectionObserverCallback }[] = [];
  class Told {
    constructor(private readonly heard: IntersectionObserverCallback) {}
    observe(el: Element): void {
      watched.push({ el, heard: this.heard });
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  const seeNear = (name: string): void => {
    const tile = row(name);
    for (const w of watched.filter((one) => one.el === tile)) w.heard([{ target: tile, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  };
  /** Gives elements that match `selector` a size, as a window with layout would. */
  const sized = (selector: string, size: { width?: number; height?: number; scroll?: number }) => {
    const proto = HTMLElement.prototype;
    const was = { w: Object.getOwnPropertyDescriptor(proto, "clientWidth"), h: Object.getOwnPropertyDescriptor(proto, "clientHeight"), s: Object.getOwnPropertyDescriptor(proto, "scrollHeight") };
    Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.matches(selector) ? (size.width ?? 0) : 0; } });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get(this: HTMLElement) { return this.matches(selector) ? (size.height ?? 0) : 0; } });
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get(this: HTMLElement) { return this.matches(selector) ? (size.scroll ?? 0) : 0; } });
    return () => {
      for (const [key, desc] of [["clientWidth", was.w], ["clientHeight", was.h], ["scrollHeight", was.s]] as const) {
        if (desc) Object.defineProperty(proto, key, desc);
        else delete (proto as unknown as Record<string, unknown>)[key];
      }
    };
  };
  beforeEach(() => {
    watched.length = 0;
    delete listingSeams.fetch;
  });

  it("asks for a tile's picture only once the tile is near what the grid shows, and the glyph holds its place meanwhile", async () => {
    vi.stubGlobal("IntersectionObserver", Told);
    keepPageLook(PAGE.at, { shape: "grid" });
    draw();
    await act(async () => void (await new Promise((done) => setTimeout(done, 60))));
    expect(asked("work.files.thumbs")).toEqual([]);
    expect(row("Plan.pdf").querySelector("[data-kind-glyph='pdf']")).not.toBeNull();
    // One observer for the grid, watching each tile.
    expect(watched.length).toBe(ENTRIES.length);
    act(() => seeNear("Plan.pdf"));
    await waitFor(() => expect(asked("work.files.thumbs")).toHaveLength(1));
    expect((asked("work.files.thumbs")[0]!.refs as { path: string }[]).map((ref) => ref.path)).toEqual(["/w/Plan.pdf"]);
    await waitFor(() => expect(row("Plan.pdf").querySelector("img")).not.toBeNull());
  });

  it("fits a tile's picture inside its box rather than letting a tall page run past it", async () => {
    keepPageLook(PAGE.at, { shape: "grid" });
    draw();
    const img = await waitFor(() => {
      const el = row("Plan.pdf").querySelector("img");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(img.className).toContain("size-full");
    expect(img.className).toContain("object-contain");
    expect(img.className).not.toContain("max-h-full");
  });

  it("draws the last column of Columns from the page's filtered rows, walks only them, and brings the row walked to into view", async () => {
    listingSeams.fetch = async () => ({ entries: ENTRIES, place: "folder", trail: [{ name: "Dummy Esports", at: at("/w") }] });
    const seen: string[] = [];
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      seen.push(this.getAttribute("data-files-row") ?? "");
    };
    try {
      keepPageLook(PAGE.at, { shape: "columns" });
      draw({ find: { link: "box", workspaceId: "w1", tabs: [], mode: "search", setMode: () => undefined, onGoTo: () => undefined, onSearch: () => undefined } });
      fireEvent.change(document.querySelector<HTMLInputElement>("[data-files-bar] input")!, { target: { value: "p" } });
      const column = await waitFor(() => {
        const el = document.querySelector<HTMLElement>("[data-files-column='Dummy Esports']")!;
        expect([...el.querySelectorAll("[data-files-row]")].map((r) => r.getAttribute("data-files-row"))).toEqual(["file:env_box:/w/Plan.pdf", "file:env_box:/w/Poster.png", "file:env_box:/w/art.zip", "file:env_box:/w/theme.mp3"]);
        return el;
      });
      const box = document.querySelector<HTMLElement>("[data-files-columns]")!;
      fireEvent.keyDown(box, { key: "ArrowDown" });
      fireEvent.keyDown(box, { key: "ArrowDown" });
      expect(row("Poster.png").getAttribute("aria-selected")).toBe("true");
      expect(seen.at(-1)).toBe("file:env_box:/w/Poster.png");
      fireEvent.keyDown(box, { key: "ArrowDown" });
      fireEvent.keyDown(box, { key: "ArrowDown" });
      fireEvent.keyDown(box, { key: "ArrowDown" });
      // The walk ends at the last row the filter left: nothing it hid is selected.
      expect(column.querySelector("[aria-selected='true']")!.getAttribute("data-files-row")).toBe("file:env_box:/w/theme.mp3");
    } finally {
      HTMLElement.prototype.scrollIntoView = scroll;
    }
  });

  it("holds the folder on the way down lighter once the keys are in the column right of it", async () => {
    listingSeams.fetch = async (_from, folder) => ({ entries: "path" in folder && folder.path === "/w" ? ENTRIES : [file("Run sheet.pdf", "pdf")], place: "folder", trail: [] });
    keepPageLook(at("/w/Events"), { shape: "columns" });
    draw({ page: { at: at("/w/Events"), name: "Events" }, trail: [{ name: "Dummy Esports", at: at("/w") }, { name: "Events", at: at("/w/Events") }] });
    const held = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-files-column='Dummy Esports'] [data-files-held]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(held.getAttribute("data-files-row")).toBe(FOLDER.key);
    expect(held.className).toContain("bg-muted");
    expect(held.className).toContain("group-focus-within/columns:bg-foreground/5");
    expect(document.querySelector("[data-files-columns]")!.className).toContain("group/columns");
  });

  it("fills and announces every file selected in Gallery's strip, and shows the one the arrows rest on", () => {
    keepPageLook(PAGE.at, { shape: "gallery" });
    const place = { ...PLACE, can: ["move", "copy"] } as unknown as FilePlace;
    draw({ acts: { place, from: { ...COPY, place }, tabs: true, make: async () => null, rename: async () => null, carry: () => undefined, trash: () => undefined, restore: () => undefined, purge: () => undefined, star: () => undefined, openTab: () => undefined, openApp: () => undefined, pickUpload: () => undefined, upload: () => undefined, drop: () => undefined, uploading: null, cancelUpload: () => undefined } as never });
    fireEvent.click(row("Budget.xlsx"));
    fireEvent.click(row("notes.txt"), { shiftKey: true });
    const selected = [...document.querySelectorAll("[data-files-strip] [aria-selected='true']")].map((el) => el.getAttribute("aria-label"));
    expect(selected).toEqual(["Budget.xlsx", "Plan.pdf", "notes.txt"]);
    for (const name of ["Budget.xlsx", "Plan.pdf", "notes.txt"]) expect(row(name).className).toContain("bg-muted");
    expect(document.querySelector("[data-files-strip]")!.getAttribute("aria-multiselectable")).toBe("true");
    expect(document.querySelector("[data-files-preview]")!.getAttribute("data-files-preview")).toBe("file:env_box:/w/notes.txt");
  });

  it("shows in Beside the file as the list has it now, when it changes under the same key", async () => {
    keepPageLook(PAGE.at, { shape: "beside" });
    const listing = (entries: FileEntry[]) => ({ entries, trail: [{ name: "Dummy Esports", at: at("/w") }], loaded: true, more: false, loading: false, error: null, away: false, loadMore: () => undefined, retry: () => undefined });
    const view = draw();
    fireEvent.click(row("Plan.pdf"));
    await waitFor(() => expect(document.querySelector("[data-files-preview]")?.getAttribute("data-files-preview")).toBe("file:env_box:/w/Plan.pdf"));
    expect(document.querySelector("[data-files-fetch]")).toBeNull();
    // The same file, now kept in the cloud: the right half says so and offers the download.
    const moved = ENTRIES.map((e) => (e.name === "Plan.pdf" ? { ...e, local: false, state: { is: "cloud" as const } } : e));
    view.rerender(
      <PageView page={PAGE} panelId="p1" listing={listing(moved)} copy={COPY} from={{ workspaceId: "w1", copy: COPY }} trail={[{ name: "Dummy Esports", at: at("/w") }]} canBack={false} canForward={false} busy={null} fixes={{ busy: false, run: () => undefined }} seat={{ workspace, can: (entry) => !!entry.ref }} onFetch={async () => undefined} onBack={() => undefined} onForward={() => undefined} onGo={() => undefined} onOpen={() => undefined} />,
    );
    expect(document.querySelector("[data-files-fetch]")?.textContent).toBe("Download and Open");
    // Its second line says where it is in words.
    expect(row("Plan.pdf").textContent).toContain("In the cloud");
  });

  it("leaves Beside's right half empty with nothing selected", () => {
    keepPageLook(PAGE.at, { shape: "beside" });
    draw();
    const beside = document.querySelector<HTMLElement>("[data-files-beside]")!;
    expect(beside.lastElementChild!.textContent).toBe("");
  });

  it("lets Beside's list and file take turns where both cannot fit, with a way back to the list", async () => {
    const undo = sized("[data-files-beside]", { width: 400 });
    try {
      keepPageLook(PAGE.at, { shape: "beside" });
      draw();
      const list0 = document.querySelector<HTMLElement>("[data-files-list]")!;
      expect(list0.style.width).toBe("");
      expect(document.querySelector("[data-files-preview]")).toBeNull();
      fireEvent.click(row("Plan.pdf"));
      // The file takes the whole body; the list is gone until Back.
      expect(document.querySelector("[data-files-list]")).toBeNull();
      expect(document.querySelector("[data-files-preview]")!.getAttribute("data-files-preview")).toBe("file:env_box:/w/Plan.pdf");
      fireEvent.click(screen.getByRole("button", { name: "Back to the list" }));
      expect(document.querySelector("[data-files-list]")).not.toBeNull();
      expect(row("Plan.pdf").getAttribute("aria-selected")).toBe("true");
    } finally {
      undo();
    }
  });

  it("narrows Beside's list before the file gets tight", async () => {
    const { besideShape } = await import("./Looks");
    expect(besideShape(0)).toEqual({ list: 280, turns: false });
    expect(besideShape(1200)).toEqual({ list: 280, turns: false });
    expect(besideShape(700)).toEqual({ list: 220, turns: false });
    expect(besideShape(560)).toEqual({ list: 200, turns: false });
    expect(besideShape(519)).toEqual({ list: 519, turns: true });
  });

  it("shows a text file in Quick Look as its first lines in the mono face, read and never opened", async () => {
    draw();
    fireEvent.click(row("notes.txt"));
    fireEvent.keyDown(list(), { key: " " });
    const layer = screen.getByRole("dialog", { name: "Quick Look: notes.txt" });
    const pre = await waitFor(() => {
      const el = layer.querySelector("[data-files-preview-text] pre");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(pre.textContent).toBe("Practice starts at 4 PM.\nBring the bracket.");
    expect(pre.className).toContain("font-mono");
    expect(asked("work.files.read")).toEqual([{ workspaceId: "w1", ref: at("/w/notes.txt"), offset: 0, length: 32 * 1024 }]);
    expect(asked("work.files.preview")).toEqual([]);
    // A file of no kind whose bytes are no text keeps its facts.
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    const bin = screen.getByRole("dialog", { name: "Quick Look: data.bin" });
    await waitFor(() => expect(asked("work.files.read")).toHaveLength(2));
    expect(bin.querySelector("[data-files-preview-text]")).toBeNull();
    expect(bin.querySelector("[data-files-preview-plain]")).not.toBeNull();
  });

  it("reads nothing of a text file kept in the cloud before his press, and shows a text file's first lines in the details pane", async () => {
    const cloudy = [...ENTRIES, file("Cloud notes.txt", "text", { local: false, state: { is: "cloud" } })];
    keepPageLook(PAGE.at, { details: true });
    draw({ listing: { entries: cloudy, trail: [], loaded: true, more: false, loading: false, error: null, away: false, loadMore: () => undefined, retry: () => undefined } });
    fireEvent.click(row("Cloud notes.txt"));
    fireEvent.keyDown(list(), { key: " " });
    expect(screen.getByRole("dialog", { name: "Quick Look: Cloud notes.txt" }).textContent).toContain("It is kept in the cloud.");
    expect(asked("work.files.read")).toEqual([]);
    fireEvent.keyDown(list(), { key: "Escape" });
    fireEvent.click(row("notes.txt"));
    await waitFor(() => expect(document.querySelector("[data-files-details-text]")?.textContent).toBe("Practice starts at 4 PM.\nBring the bracket."));
  });

  it("draws the next pages at once where the pages drawn already end in sight, with no scroll", async () => {
    const undo = sized("[data-files-preview-pages]", { width: 900, height: 700, scroll: 760 });
    try {
      draw();
      fireEvent.click(row("Plan.pdf"));
      fireEvent.keyDown(list(), { key: " " });
      // Page 3 is asked with no scroll: the two drawn end inside the pane.
      await waitFor(() => expect(new Set(asked("work.files.preview").map((a) => a.page))).toEqual(new Set([1, 2, 3])));
    } finally {
      undo();
    }
  });

  it("keeps Tab on Quick Look's own controls, walks the list on an arrow from them, and gives the list its focus back on close", async () => {
    draw();
    fireEvent.click(row("Plan.pdf"));
    list().focus();
    fireEvent.keyDown(list(), { key: " " });
    const layer = screen.getByRole("dialog", { name: "Quick Look: Plan.pdf" });
    const open = layer.querySelector<HTMLElement>("[data-files-quicklook-open]")!;
    const close = screen.getByRole("button", { name: "Close Quick Look" });
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(open);
    fireEvent.keyDown(open, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(open);
    fireEvent.keyDown(open, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
    // An arrow on its own control walks the list under it, and the layer follows.
    fireEvent.keyDown(close, { key: "ArrowDown" });
    expect(screen.getByRole("dialog", { name: "Quick Look: notes.txt" })).toBeTruthy();
    expect(document.activeElement).toBe(list());
    fireEvent.keyDown(list(), { key: "Tab" });
    expect(layer.contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Quick Look" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(list());
  });

  it("cuts the place in Quick Look's head only at a word", () => {
    draw({ page: { at: at("/w"), name: "Esports Staff, General" } });
    fireEvent.click(row("Plan.pdf"));
    fireEvent.keyDown(list(), { key: " " });
    const where = document.querySelector<HTMLElement>("[data-files-quicklook-where]")!;
    expect(where.className).toContain("flex-wrap");
    expect(where.className).toContain("overflow-hidden");
    const parts = [...where.querySelectorAll("[aria-hidden]")].map((el) => el.textContent);
    expect(parts).toEqual(["", "Esports", " Staff, General"]);
    expect(where.querySelector(".sr-only")!.textContent).toBe("Esports Staff, General");
  });
});
