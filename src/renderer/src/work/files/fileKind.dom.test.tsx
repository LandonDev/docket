// @vitest-environment jsdom
/**
 * A file open as itself (docs/DESIGN.md "The Files place"): the `file` kind's body in a Files tab under the file's
 * header, against a stand-in host that keeps one folder of files. The editor itself is CodeMirror, which needs a
 * layout jsdom has not: a plain field stands in for it here, and the session under it is the real one.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileBytes, FileSaved, FileTab } from "@shared/contract-work-files";
import type { CanvasItem, CanvasSource } from "@shared/work";
import type { FileEntry } from "@shared/work/files";
import type { WorkspaceMeta } from "../../lib/tcserver/types";

// The whole suite runs these beside a hundred other files: a wait for the screen is given room.
configure({ asyncUtilTimeout: 5000 });

interface Kept {
  text: string;
  version: number;
  changed: number;
  gone?: boolean;
  locked?: string;
}
const disk = vi.hoisted(() => ({ files: new Map<string, unknown>(), calls: [] as { method: string; params: Record<string, unknown> }[], pushes: new Set<(push: Record<string, unknown>) => void>() }));
const kept = (path: string): Kept => disk.files.get(path) as Kept;

vi.mock("../../lib/connection", async (original) => {
  const pathOf = (ref: unknown): string => (ref as { path: string }).path;
  const b64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const linkOf = (id: string) => ({
    environmentId: id,
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      disk.calls.push({ method, params });
      if (method === "work.files.read") {
        const file = disk.files.get(pathOf(params.ref)) as Kept | undefined;
        if (!file || file.gone) throw new Error("Notes.md is not there any more.");
        return { data: b64(file.text), size: file.text.length, version: `v${file.version}`, changed: file.changed, end: true, ...(file.locked ? { locked: file.locked } : {}) } satisfies FileBytes;
      }
      if (method === "work.files.stat") {
        return {
          entries: (params.refs as unknown[]).map((ref) => {
            const file = disk.files.get(pathOf(ref)) as Kept | undefined;
            const name = pathOf(ref).split("/").pop()!;
            return file && !file.gone ? ({ key: pathOf(ref), ref: ref as CanvasSource, folder: null, name, kind: name.endsWith(".zip") ? "archive" : name.endsWith(".mp3") ? "audio" : "text", size: 2_400_000, changed: file.changed } satisfies FileEntry) : null;
          }),
        };
      }
      if (method === "work.files.write") {
        const file = disk.files.get(pathOf(params.ref)) as Kept;
        if (params.copy) return { copy: { key: "c", ref: null, folder: null, name: "Notes (mine).md", kind: "text" } } satisfies FileSaved;
        if (file.gone) return { conflict: { gone: true } } satisfies FileSaved;
        if (params.version !== `v${file.version}`) return { conflict: { version: `v${file.version}`, changed: file.changed } } satisfies FileSaved;
        Object.assign(file, { text: params.text, version: file.version + 1, changed: file.changed + 60_000 });
        return { version: `v${file.version}`, changed: file.changed } satisfies FileSaved;
      }
      if (method === "work.files.copyBack") return { is: "ok" };
      if (method === "work.files.archive") return { entries: [{ name: "art/", size: 0, dir: true }, { name: "art/poster.png", size: 2048, dir: false }], more: true };
      if (method === "work.canvas.keep") return { path: "/w/kept.pdf", name: "kept.pdf" };
      throw new Error(`unexpected ${method}`);
    },
    onPush: (listener: (push: Record<string, unknown>) => void) => (disk.pushes.add(listener), () => disk.pushes.delete(listener)),
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: () => true, environment: () => undefined, environments: () => [], onLink: () => () => undefined } };
});
// The editor's stand-in: a field that shows the text it was given and reports what is typed, read only when told.
vi.mock("./FileTextEditor", () => ({
  FileTextEditor: ({ name, text, readOnly, onChange }: { name: string; text: string; readOnly: boolean; onChange(text: string): void }) => (
    <textarea aria-label={name} defaultValue={text} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const { FileTabView } = await import("./FileTabView");
const { SAVE_AFTER_MS } = await import("./fileSession");

const workspace = { id: "w1", environmentId: "box", path: "/w" } as Pick<WorkspaceMeta, "id" | "environmentId" | "path">;
const AT = new Date(2026, 10, 23, 13, 52).getTime();
const item = (path: string, over: Partial<CanvasItem> = {}): CanvasItem => ({ id: "i1", sessionId: "filespane_w1", workspaceId: "w1", kind: "file", title: path.split("/").pop()!, source: { at: "file", host: "env_box", path }, state: "open", position: 0, rev: 0, createdAt: 1, updatedAt: 1, ...over }) as CanvasItem;
const tab = (name: string, over: Partial<FileTab> = {}): FileTab => ({ id: "t1", kind: "file", name, itemId: "i1", key: name, ...over });
const line = (): string | null => document.querySelector("[data-files-save-line]")?.textContent ?? null;
const writes = (): Record<string, unknown>[] => disk.calls.filter((c) => c.method === "work.files.write").map((c) => c.params);

function show(path: string, over: { tab?: Partial<FileTab>; item?: Partial<CanvasItem>; copy?: { host: string; openThere?(): void; send?(): Promise<unknown>; reload?(): Promise<void>; keepBoth?(): Promise<void> } | null; onShowFolder?(): void } = {}) {
  const name = path.split("/").pop()!;
  return render(<FileTabView tab={tab(name, over.tab)} item={item(path, over.item)} panelId="p" workspace={workspace} where="Events" copy={over.copy ?? null} onClose={() => undefined} onShowFolder={over.onShowFolder} />);
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 10, 23, 14, 30), toFake: ["Date"] });
  disk.files.clear();
  disk.calls.length = 0;
  disk.pushes.clear();
  disk.files.set("/w/Events/Notes.md", { text: "first line\n", version: 1, changed: AT } satisfies Kept);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a text file in a tab", () => {
  it("opens in the editor, and the line under its name says when it was saved and where: the folder is a press", async () => {
    const onShowFolder = vi.fn();
    show("/w/Events/Notes.md", { onShowFolder });
    const field = (await screen.findByRole("textbox", { name: "Notes.md" })) as HTMLTextAreaElement;
    expect(field.value).toBe("first line\n");
    await waitFor(() => expect(line()).toBe("Saved 1:52 PM in Events"));
    fireEvent.click(screen.getByRole("button", { name: "Events" }));
    expect(onShowFolder).toHaveBeenCalledTimes(1);
    // There is no save press anywhere.
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("saves what he types after a pause, naming the version it read", async () => {
    show("/w/Events/Notes.md");
    const field = await screen.findByRole("textbox", { name: "Notes.md" });
    await waitFor(() => expect(line()).toContain("Saved"));
    fireEvent.change(field, { target: { value: "first line\nsecond\n" } });
    expect(line()).toBe("Saving…");
    expect(writes()).toEqual([]);
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: SAVE_AFTER_MS + 1500 });
    expect(writes()[0]).toMatchObject({ workspaceId: "w1", text: "first line\nsecond\n", version: "v1" });
    await waitFor(() => expect(line()).toBe("Saved 1:53 PM in Events"));
    expect(kept("/w/Events/Notes.md").text).toBe("first line\nsecond\n");
  });

  it("never writes over a second writer: the line takes the foreground with Reload and Keep mine as a copy", async () => {
    show("/w/Events/Notes.md");
    const field = await screen.findByRole("textbox", { name: "Notes.md" });
    await waitFor(() => expect(line()).toContain("Saved"));
    Object.assign(kept("/w/Events/Notes.md"), { text: "theirs\n", version: 2, changed: new Date(2026, 10, 23, 14, 4).getTime() });
    fireEvent.change(field, { target: { value: "mine\n" } });
    await waitFor(() => expect(line()).toBe("This file changed at 2:04 PM"), { timeout: SAVE_AFTER_MS + 1500 });
    expect(document.querySelector("[data-files-save-line]")).toMatchObject({ className: expect.stringContaining("text-foreground") });
    expect(document.querySelector("[data-files-save-line]")!.getAttribute("role")).toBe("status");
    expect(kept("/w/Events/Notes.md").text).toBe("theirs\n");
    expect(screen.getByRole("button", { name: "Keep mine as a copy" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Notes.md" }) as HTMLTextAreaElement).value).toBe("theirs\n"));
    await waitFor(() => expect(line()).toBe("Saved 2:04 PM in Events"));
  });

  it("keeps his text as a copy beside the file on that press", async () => {
    show("/w/Events/Notes.md");
    const field = await screen.findByRole("textbox", { name: "Notes.md" });
    await waitFor(() => expect(line()).toContain("Saved"));
    Object.assign(kept("/w/Events/Notes.md"), { text: "theirs\n", version: 2, changed: AT + 720_000 });
    fireEvent.change(field, { target: { value: "mine\n" } });
    fireEvent.click(await screen.findByRole("button", { name: "Keep mine as a copy" }, { timeout: SAVE_AFTER_MS + 1500 }));
    await waitFor(() => expect(writes().at(-1)).toMatchObject({ copy: true, text: "mine\n" }));
    expect(kept("/w/Events/Notes.md").text).toBe("theirs\n");
  });

  it("sends what waits when the tab closes under the editor", async () => {
    const shown = show("/w/Events/Notes.md");
    const field = await screen.findByRole("textbox", { name: "Notes.md" });
    await waitFor(() => expect(line()).toContain("Saved"));
    fireEvent.change(field, { target: { value: "typed, then closed\n" } });
    shown.unmount();
    await waitFor(() => expect(kept("/w/Events/Notes.md").text).toBe("typed, then closed\n"));
  });

  it("is read only where the host would refuse a save, and says why in the line", async () => {
    disk.files.set("/cloud/General/Agenda.md", { text: "team text\n", version: 1, changed: AT, locked: "Files in the Windows VM cannot be changed from here yet. Open it there." } satisfies Kept);
    show("/cloud/General/Agenda.md");
    const field = (await screen.findByRole("textbox", { name: "Agenda.md" })) as HTMLTextAreaElement;
    expect(field.readOnly).toBe(true);
    await waitFor(() => expect(line()).toBe("Read only. Files in the Windows VM cannot be changed from here yet. Open it there"));
  });

  it("takes a change made elsewhere when the folder says something changed and nothing waits here", async () => {
    show("/w/Events/Notes.md");
    await screen.findByRole("textbox", { name: "Notes.md" });
    await waitFor(() => expect(line()).toContain("Saved"));
    Object.assign(kept("/w/Events/Notes.md"), { text: "changed by a thread\n", version: 2, changed: AT + 120_000 });
    act(() => disk.pushes.forEach((listener) => listener({ push: "work.files", workspaceId: "w1", at: "file:env_box:/w/Events" })));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Notes.md" }) as HTMLTextAreaElement).value).toBe("changed by a thread\n"));
  });
});

describe("a file no editor here shows", () => {
  it("shows its facts with Download, and nothing says there is no viewer", async () => {
    disk.files.set("/w/Events/Assets.zip", { text: "PK", version: 1, changed: AT } satisfies Kept);
    show("/w/Events/Assets.zip");
    const facts = await waitFor(() => {
      const el = document.querySelector("[data-file-facts]");
      expect(el).toBeTruthy();
      return el!;
    });
    // The header names the file; the page under it says its facts in one sentence and never the name again.
    expect(facts.textContent).not.toContain("Assets.zip");
    expect(facts.querySelector("h3")).toBeNull();
    expect(facts.textContent).toContain("Archive, 2 MB, changed 1:52 PM");
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/no viewer/i);
    // Its bytes are not read to show its facts, and the header keeps the frame's own line.
    expect(disk.calls.map((c) => c.method).filter((m) => m !== "work.files.archive")).toEqual(["work.files.stat"]);
    expect(document.querySelector("[data-files-header]")!.textContent).toContain("In Events");
  });

  it("lists what a zip holds under its facts, from its directory alone, and says when it holds more", async () => {
    disk.files.set("/w/Events/Assets.zip", { text: "PK", version: 1, changed: AT } satisfies Kept);
    show("/w/Events/Assets.zip");
    const listing = await screen.findByRole("list", { name: "In this archive" });
    expect([...listing.querySelectorAll("[role=listitem]")].map((row) => row.textContent)).toEqual(["art/", "art/poster.png2 KB"]);
    expect(listing.textContent).toContain("It holds more than are listed here.");
    expect(disk.calls.some((c) => c.method === "work.files.read")).toBe(false);
  });

  it("plays a sound here on a press: nothing of it is read before, and its bytes come by the tab's own item", async () => {
    const made: Blob[] = [];
    Object.assign(URL, { createObjectURL: (blob: Blob) => (made.push(blob), "blob:sound"), revokeObjectURL: () => undefined });
    disk.files.set("/w/Events/theme.mp3", { text: "ID3", version: 1, changed: AT } satisfies Kept);
    show("/w/Events/theme.mp3");
    const play = await screen.findByRole("button", { name: "Play" });
    expect(document.querySelector("[data-file-facts='audio']")).toBeTruthy();
    expect(disk.calls.some((c) => c.method === "work.files.read")).toBe(false);
    await act(async () => void fireEvent.click(play));
    await waitFor(() => expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:sound"));
    expect(disk.calls.filter((c) => c.method === "work.files.read").map((c) => c.params.itemId)).toEqual(["i1"]);
    expect(made[0]!.type).toBe("audio/mpeg");
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });
});

describe("two files in one tab", () => {
  it("shows the second file at the side under a head of its own, and its close leaves the tab's own file", async () => {
    disk.files.set("/w/Events/Rules.md", { text: "no outside food\n", version: 1, changed: AT } satisfies Kept);
    const onCloseSide = vi.fn();
    render(
      <FileTabView
        tab={tab("Notes.md", { side: { itemId: "i2", key: "Rules.md", name: "Rules.md" } })}
        item={item("/w/Events/Notes.md")}
        sideItem={item("/w/Events/Rules.md", { id: "i2" })}
        onCloseSide={onCloseSide}
        panelId="p"
        workspace={workspace}
        where="Events"
        copy={null}
        onClose={() => undefined}
      />,
    );
    expect(((await screen.findByRole("textbox", { name: "Notes.md" })) as HTMLTextAreaElement).value).toBe("first line\n");
    const side = screen.getByRole("region", { name: "Rules.md" });
    expect(((await screen.findByRole("textbox", { name: "Rules.md" })) as HTMLTextAreaElement).value).toBe("no outside food\n");
    // Each file says where its own saving stands.
    await waitFor(() => expect(side.querySelector("[data-files-save-line]")?.textContent).toBe("Saved 1:52 PM"));
    expect(document.querySelector("[data-files-header] [data-files-save-line]")?.textContent).toBe("Saved 1:52 PM in Events");
    fireEvent.click(screen.getByRole("button", { name: "Close Rules.md" }));
    expect(onCloseSide).toHaveBeenCalledTimes(1);
    // A sash stands between the two, to give either more room.
    expect(screen.getByRole("separator", { name: "Resize the two files" })).toBeTruthy();
  });
});

describe("the frame's own lines", () => {
  it("says whose copy a copy is, with the press that opens the file where it is kept", async () => {
    const openThere = vi.fn();
    disk.files.set("/data/copies/Agenda.md", { text: "team text\n", version: 1, changed: AT, locked: "This is a copy. Changes are made where the file is kept." } satisfies Kept);
    show("/data/copies/Agenda.md", { tab: { copyOf: { host: "env_mac", path: "/Users/l/OneDrive/Agenda.md" } }, copy: { host: "MacBook", openThere } });
    await screen.findByRole("textbox", { name: "Agenda.md" });
    await waitFor(() => expect(line()).toBe("A copy from MacBook. Changes stay here"));
    fireEvent.click(screen.getByRole("button", { name: "Open on MacBook" }));
    await waitFor(() => expect(openThere).toHaveBeenCalledTimes(1));
    // The read named the tab's own item, since a copy lies in no place.
    expect(disk.calls.find((c) => c.method === "work.files.read")!.params).toMatchObject({ itemId: "i1" });
  });
});

describe("a copy that saves back to its file", () => {
  const COPY = "/data/copies/Agenda.md";
  const copyOf = { host: "env_mac", path: "/Users/l/OneDrive/Agenda.md" };
  beforeEach(() => disk.files.set(COPY, { text: "team text\n", version: 1, changed: AT } satisfies Kept));
  const header = (): HTMLElement => document.querySelector("[data-files-header]")!;

  it("says the file is on its computer, saves into the copy, then asks the host to send it back", async () => {
    show(COPY, { tab: { copyOf, back: { is: "ok" } }, copy: { host: "MacBook" } });
    const field = await screen.findByRole("textbox", { name: "Agenda.md" });
    await waitFor(() => expect(line()).toBe("On MacBook"));
    // Nothing is sent for the line read at open.
    expect(disk.calls.some((c) => c.method === "work.files.copyBack")).toBe(false);
    fireEvent.change(field, { target: { value: "team text\nmore\n" } });
    expect(line()).toBe("Saving to MacBook…");
    await waitFor(() => expect(disk.calls.filter((c) => c.method === "work.files.copyBack").map((c) => c.params)).toEqual([{ workspaceId: "w1", tabId: "t1" }]), { timeout: 5000 });
    expect(writes()[0]).toMatchObject({ ref: { at: "file", host: "env_box", path: COPY }, text: "team text\nmore\n" });
  });

  it("says when its file last took his changes, muted, with no press", async () => {
    show(COPY, { tab: { copyOf, back: { is: "ok", at: AT } }, copy: { host: "MacBook" } });
    await waitFor(() => expect(line()).toBe("Saved to MacBook 1:52 PM"));
    expect(header().querySelector("[data-files-save-line]")!.className).toContain("text-muted-foreground");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says a file that changed there in the foreground, with Reload and Keep Both", async () => {
    const keepBoth = vi.fn(async () => undefined);
    show(COPY, { tab: { copyOf, back: { is: "changed", at: AT } }, copy: { host: "MacBook", keepBoth, reload: async () => undefined } });
    await waitFor(() => expect(line()).toBe("This file changed on MacBook"));
    expect(header().querySelector("[data-files-save-line]")!.className).toContain("text-foreground");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep Both" }));
    await waitFor(() => expect(keepBoth).toHaveBeenCalledTimes(1));
  });

  it("says its computer is not answering, with Retry, which sends again", async () => {
    const send = vi.fn(async () => ({ is: "ok" }));
    show(COPY, { tab: { copyOf, back: { is: "away" } }, copy: { host: "MacBook", send } });
    await waitFor(() => expect(line()).toBe("MacBook is not answering. Changes wait here"));
    expect(header().querySelector("[data-files-save-line]")!.getAttribute("role")).toBe("status");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it("says its computer refused, in that computer's words", async () => {
    show(COPY, { tab: { copyOf, back: { is: "refused", detail: "this host's bridge is off for that host (Settings → Hosts)" } }, copy: { host: "MacBook", send: async () => undefined } });
    await waitFor(() => expect(line()).toBe("MacBook refused the save. This host's bridge is off for that host (Settings → Hosts)"));
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps the copy's own line where its kind saves into the copy alone: changes stay here", async () => {
    show(COPY, { tab: { copyOf }, copy: { host: "MacBook" } });
    await screen.findByRole("textbox", { name: "Agenda.md" });
    await waitFor(() => expect(line()).toBe("A copy from MacBook. Changes stay here"));
  });
});
