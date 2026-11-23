// @vitest-environment jsdom
/**
 * The list and its states in the Files place (docs/DESIGN.md "The Files place"), drawn from a page with no host:
 * the trail and names that are cut, a row's press, the one line over the list (an upload, a later page that did not
 * load, what a search left out), an empty folder and one that is gone, and the containers the columns and the
 * details pane each measure.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePage } from "@shared/contract-work-files";
import type { FileEntry, FilePlace } from "@shared/work/files";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";

vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({ environmentId: id, connected: true, request: async () => ({ thumbs: [], entries: [] }), onPush: () => () => undefined, onOpen: () => () => undefined, onClose: () => () => undefined });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: () => true, environment: (id: string) => ({ id, name: "The box", platform: "linux" }), environments: () => [], onLink: () => () => undefined } };
});

const { PageView } = await import("./Page");
const { keepPageLook, resetFilesStore } = await import("./store");

const at = (path: string) => ({ at: "file" as const, host: "env_box", path });
const PLACE = { id: "folder", kind: "folder", name: "Dummy Esports", host: "", env: "env_box", shared: false, can: ["move", "copy", "upload", "make"], makes: ["folder"], state: { state: "ok" }, root: at("/w") } as unknown as FilePlace;
const COPY = { place: PLACE, link: "box", host: "The box", wire: "files" as const };
const PAGE: FilePage = { at: at("/w/Events"), name: "Events" };
const TRAIL = [
  { name: "Dummy Esports", at: at("/w") },
  { name: "Events", at: at("/w/Events") },
];
const file = (name: string): FileEntry => ({ key: `file:env_box:/w/Events/${name}`, ref: at(`/w/Events/${name}`), folder: null, name, kind: "sheet", changed: 1_700_000_000_000 });
const ENTRIES = [file("Budget.xlsx"), file("Roster.xlsx")];
type Listed = Parameters<typeof PageView>[0]["listing"];
const listing = (over: Partial<NonNullable<Listed>> = {}): NonNullable<Listed> => ({ entries: ENTRIES, trail: TRAIL, loaded: true, more: false, loading: false, error: null, away: false, loadMore: () => undefined, retry: () => undefined, ...over });
const acts = (over: Record<string, unknown> = {}) =>
  ({ place: PLACE, from: COPY, tabs: true, make: async () => null, rename: async () => null, carry: () => undefined, trash: () => undefined, restore: () => undefined, purge: () => undefined, star: () => undefined, openTab: () => undefined, openApp: () => undefined, pickUpload: () => undefined, upload: () => undefined, drop: () => undefined, uploading: null, cancelUpload: () => undefined, ...over }) as never;

function draw(over: Partial<Parameters<typeof PageView>[0]> = {}) {
  const went: string[] = [];
  const view = render(
    <PageView
      page={PAGE}
      panelId="p1"
      listing={listing()}
      copy={COPY}
      from={{ workspaceId: "w1", copy: COPY }}
      trail={TRAIL}
      canBack={false}
      canForward={false}
      busy={null}
      fixes={{ busy: false, run: () => undefined }}
      onBack={() => void went.push("back")}
      onForward={() => undefined}
      onGo={(page) => void went.push(page.name)}
      onOpen={() => undefined}
      {...over}
    />,
  );
  return { ...view, went };
}
const row = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[data-files-row="file:env_box:/w/Events/${name}"]`)!;

beforeEach(() => {
  localStorage.clear();
  resetFilesStore();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("cut text", () => {
  it("gives the folder's name in the trail and a row's long name their whole text in a tooltip, only while cut", async () => {
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
    draw();
    expect(document.querySelector('[aria-current="page"]')!.getAttribute("data-slot")).not.toBe("tooltip-trigger");
    expect(row("Budget.xlsx").querySelector("[data-files-name]")!.getAttribute("data-slot")).not.toBe("tooltip-trigger");
    cleanup();
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    draw();
    await waitFor(() => expect(document.querySelector('[aria-current="page"]')!.getAttribute("data-slot")).toBe("tooltip-trigger"));
    expect(row("Budget.xlsx").querySelector("[data-files-name]")!.getAttribute("data-slot")).toBe("tooltip-trigger");
  });
});

describe("a row", () => {
  it("hovers and presses as every hand-drawn row does, and holds `muted` while selected", () => {
    draw();
    expect(row("Budget.xlsx").className).toContain("active:bg-foreground/12");
    expect(row("Budget.xlsx").className).toContain("duration-(--dur-hover)");
    fireEvent.click(row("Budget.xlsx"));
    expect(row("Budget.xlsx").className).toContain("bg-muted");
    expect(row("Budget.xlsx").className).not.toContain("active:bg-foreground/12");
  });
});

describe("the line over the list", () => {
  it("says an upload's place among many and how far with a comma, never a middle dot", () => {
    draw({ acts: acts({ uploading: { name: "Poster.png", index: 0, count: 3, sent: 45, total: 100 } }) });
    expect(document.querySelector("[data-files-upload]")!.textContent).toContain("1 of 3, 45%");
    expect(document.querySelector("[data-files-upload]")!.textContent).not.toContain("·");
  });

  it("keeps the rows when a later page fails, says so with Retry, and Retry asks that page again", () => {
    const more = vi.fn();
    const top = vi.fn();
    draw({ listing: listing({ more: true, error: "Permission denied.", lostPage: true, loadMore: more, retry: top }) });
    expect(screen.getByText("Budget.xlsx")).toBeTruthy();
    const line = document.querySelector<HTMLElement>("[data-view-state]")!;
    expect(line.textContent).toContain("The rest did not load");
    expect(line.textContent).toContain("Permission denied.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(more).toHaveBeenCalledTimes(1);
    expect(top).not.toHaveBeenCalled();
  });

  it("says what a search left out with Retry, whether or not anything came back", () => {
    const retry = vi.fn();
    draw({ results: true, copy: null, acts: null, listing: listing({ asleep: ["The Windows VM"], retry }) });
    const line = document.querySelector<HTMLElement>("[data-files-note]")!;
    expect(line.textContent).toContain("The Windows VM is asleep");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    cleanup();
    draw({ results: true, copy: null, acts: null, listing: listing({ entries: [], incomplete: true, retry }) });
    expect(screen.getByText("Nothing found")).toBeTruthy();
    expect(screen.getByText("Not every place was searched.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(2);
  });
});

describe("the states", () => {
  it("says an empty folder in one line, even where the place makes things and takes uploads", () => {
    draw({ acts: acts(), listing: listing({ entries: [] }) });
    expect(screen.getByText("This folder is empty")).toBeTruthy();
    expect(screen.queryByText(/Drop files here/)).toBeNull();
  });

  it("offers the folder above in Retry's place when the folder is gone, and Retry when it only did not load", () => {
    const { went } = draw({ listing: listing({ entries: [], error: "That folder is not there any more." }) });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Dummy Esports" }));
    expect(went).toEqual(["Dummy Esports"]);
    cleanup();
    const retry = vi.fn();
    draw({ listing: listing({ entries: [], error: "Permission denied.", retry }) });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("the list's columns", () => {
  it("leave by the width of the list itself, so a details pane beside it narrows them; the pane keeps the page's own width", () => {
    keepPageLook(PAGE.at, { details: true });
    draw();
    const list = document.querySelector<HTMLElement>("[data-files-list]")!;
    // The list's own wrapper is the container its columns measure; the body is another, for the pane.
    expect(list.parentElement!.className).toContain("@container/files-list");
    expect(document.querySelector("[data-files-body]")!.className).toContain("@container/files-body");
    expect(document.querySelector("[data-files-body]")!.className).not.toContain("@container/files-list");
    expect(document.querySelector("[data-files-details]")!.className).toContain("@[640px]/files-body:block");
  });
});

describe("Move to…", () => {
  it("asks the host for folders alone, a page at a time, so a folder past the first page can be picked; a place of a team is named with a comma", async () => {
    const { MoveDialog } = await import("./MoveDialog");
    const { listingSeams } = await import("./store");
    const asked: { folders: boolean; cursor?: string }[] = [];
    const folder = (name: string): FileEntry => ({ key: `file:env_box:/w/${name}`, ref: null, folder: at(`/w/${name}`), name, kind: "folder" });
    listingSeams.fetch = async (from, _at, _sort, cursor) => {
      asked.push({ folders: !!from.foldersOnly, ...(cursor ? { cursor } : {}) });
      return cursor ? { entries: [folder("Zed")] } : { entries: [folder("Archive")], next: "c1", trail: [{ name: "Dummy Esports", at: at("/w") }] };
    };
    try {
      const general = { ...COPY, place: { ...PLACE, id: "b1", kind: "teams", name: "General", root: at("/cloud/General") } };
      const sidebar = { folder: COPY, rows: [{ name: "General", group: "Esports Staff", copies: [general] }] } as never;
      render(<MoveDialog verb="move" entries={[file("Budget.xlsx")]} from={COPY} start={{ at: at("/w"), name: "Dummy Esports" }} sidebar={sidebar} workspace={{ id: "w1", name: "Dummy Esports" }} onPick={async () => true} onClose={() => undefined} />);
      await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Archive", "Zed"]));
      expect(asked).toEqual([{ folders: true }, { folders: true, cursor: "c1" }]);
      fireEvent.click(screen.getByRole("button", { name: "Places" }));
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Dummy Esports", "Esports Staff, General"]);
    } finally {
      delete listingSeams.fetch;
    }
  });
});

describe("Home", () => {
  it("shows each file once, in the first list it belongs to, and a row being opened says so with the list's spinner and word", async () => {
    const { HomePage } = await import("./Home");
    const held = { ...file("Sponsor list.xlsx"), held: { id: "h1", verb: "rename" as const } };
    const starred = { ...file("Ballroom contract.pdf"), kind: "pdf" as const };
    const home = { waiting: [held], starred: [starred, file("Sponsor list.xlsx")], recent: [file("Sponsor list.xlsx"), file("Ballroom contract.pdf"), file("Budget.xlsx")] };
    render(<HomePage panelId="p1" home={home} error={null} busy={{ key: file("Budget.xlsx").key, word: "Opening…" }} bar={null} onRetry={() => undefined} onOpen={() => undefined} />);
    const names = (list: string): string[] => [...screen.getByRole("region", { name: list }).querySelectorAll("[data-files-home-row]")].map((r) => r.querySelector("span.truncate")!.textContent ?? "");
    expect(names("Waiting on you")).toEqual(["Sponsor list.xlsx"]);
    expect(names("Starred")).toEqual(["Ballroom contract.pdf"]);
    expect(names("Recent")).toEqual(["Budget.xlsx"]);
    const opening = document.querySelector<HTMLElement>(`[data-files-home-row="${file("Budget.xlsx").key}"]`)!;
    expect(opening.textContent).toContain("Opening…");
    expect(opening.querySelector('[data-slot="busy-label"][data-busy]')).not.toBeNull();
    // A row that says a state gives its date up first in a narrow page; a plain row keeps it.
    const date = (row: Element): string => [...row.querySelectorAll("span")].at(-1)!.className;
    expect(date(opening)).toContain("hidden @[400px]/files-home:block");
    expect(date(document.querySelector(`[data-files-home-row="${held.key}"]`)!)).toContain("hidden @[400px]/files-home:block");
    expect(date(document.querySelector(`[data-files-home-row="${starred.key}"]`)!)).not.toContain("hidden");
  });
});

describe("a folder's pages", () => {
  it("keeps a later page's failure with the rows above it and its cursor, and asks that page again; keeps what a search left out", async () => {
    const { useListing, listingSeams } = await import("./store");
    const { renderHook } = await import("@testing-library/react");
    let fail = true;
    const asked: (string | undefined)[] = [];
    listingSeams.fetch = async (from, _at, _sort, cursor) => {
      asked.push(cursor);
      if (from.search) return { entries: [file("Budget.xlsx")], more: true, asleep: ["The Windows VM"] };
      if (!cursor) return { entries: [file("Budget.xlsx")], next: "c1", trail: TRAIL };
      if (fail) throw new Error("Permission denied.");
      return { entries: [file("Roster.xlsx")] };
    };
    try {
      const { result } = renderHook(() => useListing({ workspaceId: "w1", copy: COPY }, PAGE.at));
      await waitFor(() => expect(result.current.loaded).toBe(true));
      await act(async () => result.current.loadMore());
      await waitFor(() => expect(result.current.error).toBe("Permission denied."));
      expect(result.current).toMatchObject({ lostPage: true, more: true });
      expect(result.current.entries.map((e) => e.name)).toEqual(["Budget.xlsx"]);
      fail = false;
      await act(async () => result.current.loadMore());
      await waitFor(() => expect(result.current.entries.map((e) => e.name)).toEqual(["Budget.xlsx", "Roster.xlsx"]));
      expect(asked).toEqual([undefined, "c1", "c1"]);
      expect(result.current.error).toBeNull();
      expect(result.current.lostPage).toBeFalsy();
      const search = renderHook(() => useListing({ workspaceId: "w1", copy: COPY, search: { query: "budget" } }, { at: "place", id: "search" }));
      await waitFor(() => expect(search.result.current).toMatchObject({ loaded: true, incomplete: true, asleep: ["The Windows VM"] }));
    } finally {
      delete listingSeams.fetch;
    }
  });
});
