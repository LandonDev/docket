// @vitest-environment jsdom
/**
 * Files' LifeOS rows outside the LifeOS place (council round 12: Sol Files 1 and 2, Opus Files 1 and 2), each through
 * the real Files view as the app mounts it, against a stand-in host:
 * - a LifeOS document or a mail's file opens from Home and from a search's results as its own place opens it, and
 *   Show in Its Folder goes to its project, else the top of LifeOS;
 * - Recent and Starred, while the host's LifeOS is down or on its way, say so once over the list and keep their
 *   LifeOS rows greyed and shut, the rest live; each opens again once LifeOS is back;
 * - a folder whose read failed with nothing listed offers no New.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeosStatus } from "@shared/contract-work-lifeos";
import type { FilesHome, FilesListing, FileTab, SavedFileSearch } from "@shared/contract-work-files";
import type { FileEntry, FilePlace, FolderRef } from "@shared/work/files";
import { refKey } from "@shared/work/files";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { WorkViewProps } from "../views/registry";

configure({ asyncUtilTimeout: 5000 });

type Push = Record<string, unknown>;
interface Host {
  calls: { method: string; params: Record<string, unknown> }[];
  pushes: Set<(push: Push) => void>;
  answer(method: string, params: Record<string, unknown>): unknown;
}
const world = vi.hoisted(() => ({ host: null as unknown }));

vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => {
    const host = world.host as Host;
    return {
      environmentId: id,
      connected: true,
      request: async (method: string, params: Record<string, unknown> = {}) => {
        host.calls.push({ method, params });
        return host.answer(method, params);
      },
      onPush: (listener: (push: Push) => void) => (host.pushes.add(listener), () => host.pushes.delete(listener)),
      onOpen: () => () => undefined,
      onClose: () => () => undefined,
    };
  };
  return {
    ...(await original<typeof import("../../lib/connection")>()),
    registry: { linkOf, link: linkOf, has: () => true, statusOf: () => ({ lastHello: null }), environment: (id: string) => ({ id, name: "The box", platform: "linux" }), environments: () => [{ id: "box", name: "The box", platform: "linux" }], onLink: () => () => undefined },
  };
});
vi.mock("../shell/actions", () => ({
  workspaceSettings: async () => ({ mayUseDesktop: [], windowsVm: false, voice: false }),
  localHostId: async () => null,
  windowDesktops: async () => [],
  linkIdOfHost: () => "box",
  hostIdOfLink: (link: string) => link,
  allowComputers: vi.fn(),
}));
vi.mock("../winvm/signIn", () => ({ openVm: vi.fn(), signInOnVm: vi.fn(async () => undefined) }));
vi.mock("../canvas/CanvasPane", () => ({ CanvasPane: () => <div data-testid="pane" />, useKindModule: () => null }));
// The sign-in dialog the press opens in place (its own chunk, DownSignIn.tsx).
vi.mock("../shell/settings", () => ({ SignInDialog: () => <div role="dialog" aria-label="Sign in to LifeOS" /> }));
vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));

const { resetTestKey } = await import("../../lib/linkMay.testkit");
const { View } = await import("./FilesView");
const { resetFilesStore } = await import("./store");
const { resetCanvasStore } = await import("../canvas/store");
const { HOME_PAGE, savedSearchPage, searchPage } = await import("./model");
const { resetLifeos, setLifeosStatus } = await import("../shell/lifeos");

const workspace = { id: "w1", environmentId: "box", path: "/w", name: "Dummy Esports", kind: "work", sector: "purdue" } as unknown as WorkspaceMeta;
const props = { env: "box", workspace, sector: "purdue", lifeos: {}, startThread: () => undefined } as unknown as WorkViewProps;
const at = (path: string): FolderRef & { at: "file" } => ({ at: "file", host: "env_box", path });
const lens = (id: string, kind: FilePlace["kind"], name: string, over: Partial<FilePlace> = {}): FilePlace => ({ id, kind, name, host: "", env: "env_box", shared: false, can: [], state: { state: "ok" }, root: { at: "place", id }, ...over });
const FOLDER = lens("folder", "folder", "Dummy Esports", { root: at("/w"), can: ["make", "rename", "move", "copy", "edit", "trash"], makes: ["document", "folder"] });
const LIFEOS = lens("lifeos", "lifeos", "LifeOS", { can: ["make", "rename", "move", "edit"], makes: ["document", "sheet"] });
const MAIL = lens("mail", "mail", "From mail");
const PLACES: FilePlace[] = [lens("home", "home", "Home"), lens("recent", "recent", "Recent"), lens("starred", "starred", "Starred"), FOLDER, LIFEOS, MAIL];
const row = (name: string): FileEntry => ({ key: refKey(at(`/w/${name}`)), ref: at(`/w/${name}`), folder: null, name, kind: "document", changed: 1_700_000_000_000 });
const st = (state: string): LifeosStatus => ({ lifeos: { state }, keys: [] }) as unknown as LifeosStatus;

/** A promise the test settles. */
function later<T>(): { promise: Promise<T>; settle(value: T): void; fail(err: Error): void } {
  let settle!: (value: T) => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<T>((yes, no) => ((settle = yes), (fail = no)));
  return { promise, settle, fail };
}

/** A host with one tab, which answers each folder's list from `lists` in turn (a function may wait or fail). */
function standIn(tab: FileTab, o: { lists?: (() => FilesListing | Promise<FilesListing>)[]; searches?: SavedFileSearch[]; home?: FilesHome; found?: FileEntry[]; places?: () => unknown } = {}) {
  const lists = [...(o.lists ?? [])];
  const host: Host & { say(push: Push): void } = {
    calls: [],
    pushes: new Set(),
    say: (push) => host.pushes.forEach((listener) => listener(push)),
    answer(method) {
      switch (method) {
        case "work.files.places":
          return o.places?.() ?? { host: "env_box", places: PLACES, rev: 1, sources: [] };
        case "work.office.filesCopyGet":
          return { on: false };
        case "work.files.tabs":
          return { rev: 1, tabs: [tab] };
        case "work.files.tabOpen":
          return { rev: 1, tabs: [tab], tabId: tab.id };
        case "work.files.searches":
          return { searches: o.searches ?? [] };
        case "work.files.search":
          return { entries: o.found ?? [], place: "search" } satisfies FilesListing;
        case "work.files.open":
          return { rev: 1, tabs: [tab], tabId: tab.id };
        case "work.files.tabSet":
          return { rev: 2, tabs: [tab] };
        case "work.files.home":
          return o.home ?? { waiting: [], starred: [], recent: [] };
        case "work.files.list": {
          const next = lists.length > 1 ? lists.shift() : lists[0];
          return next ? next() : { entries: [], trail: [] };
        }
        case "work.files.stat":
          return { entries: [] };
        case "work.files.threads":
          return { threads: [] };
        case "work.canvas.list":
          return { items: [] };
      }
      throw new Error(`unknown method: ${method}`);
    },
  };
  world.host = host;
  return host;
}

const calls = (host: Host, method: string) => host.calls.filter((c) => c.method === method);
const page = (): HTMLElement => document.querySelector<HTMLElement>("[role=tabpanel]")!;
const note = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-files-note]");
const bones = (): HTMLElement | null => within(page()).queryByRole("status", { name: "Loading" });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetFilesStore();
  resetCanvasStore();
});
afterEach(() => {
  cleanup();
  resetLifeos();
  resetTestKey();
});


const brief: FileEntry = { key: "lifeos:docs:d1", ref: { at: "lifeos", table: "docs", id: "d1" } as never, folder: null, name: "Sponsor brief", kind: "document" };
const invoice: FileEntry = { key: "mail:m1", ref: { at: "mail", threadId: "t", messageId: "m", partId: "p", name: "Invoice.pdf", size: 10 } as never, folder: null, name: "Invoice.pdf", kind: "pdf", where: { place: "mail", name: "From mail", trail: ["Invoice"] } };
const opened = (host: Host) => calls(host, "work.files.open").map((c) => (c.params.ref as { at: string }).at);
const listRow = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>("[data-files-row]")].find((r) => r.textContent?.includes(name) || r.getAttribute("aria-label") === name)!;
const menuItems = async (): Promise<string[]> => within(await screen.findByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent ?? "");

describe("a LifeOS row from Home or a search, signed in", () => {
  it("opens a LifeOS document and a mail's file from Home as their own places open them", async () => {
    setLifeosStatus("box", st("connected"));
    const host = standIn({ id: "t1", kind: "page", name: "Home", page: HOME_PAGE }, { home: { waiting: [invoice], starred: [brief], recent: [] } });
    render(<View {...props} />);
    const homeRow = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("[data-files-home-row]")].find((b) => b.textContent?.startsWith(name))!;
    await waitFor(() => expect(homeRow("Sponsor brief")).toBeTruthy());
    fireEvent.click(homeRow("Sponsor brief"));
    await waitFor(() => expect(opened(host)).toEqual(["lifeos"]));
    fireEvent.click(homeRow("Invoice.pdf"));
    await waitFor(() => expect(opened(host)).toEqual(["lifeos", "mail"]));
  });

  it("opens a LifeOS row of a search's results, and shows its project's folder, else the top of LifeOS", async () => {
    setLifeosStatus("box", st("connected"));
    const inProject: FileEntry = { ...brief, project: { id: "p1", name: "Fall season" }, where: { place: "lifeos", name: "LifeOS", trail: ["Fall season"] } };
    const loose: FileEntry = { ...brief, key: "lifeos:sheets:s1", ref: { at: "lifeos", table: "sheets", id: "s1" } as never, name: "Budget", kind: "sheet", where: { place: "lifeos", name: "LifeOS", trail: [] } };
    const host = standIn({ id: "t1", kind: "page", name: "Results for “brief”", page: searchPage("brief") }, { found: [inProject, loose] });
    render(<View {...props} />);
    await waitFor(() => expect(listRow("Sponsor brief")).toBeTruthy());
    fireEvent.doubleClick(listRow("Sponsor brief"));
    await waitFor(() => expect(opened(host)).toEqual(["lifeos"]));
    fireEvent.contextMenu(listRow("Sponsor brief"));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Show in Its Folder" }));
    await waitFor(() => expect(calls(host, "work.files.tabSet").at(-1)?.params.page).toMatchObject({ at: { at: "project", id: "p1" }, name: "Fall season" }));
    cleanup();
    const again = standIn({ id: "t1", kind: "page", name: "Results for “brief”", page: searchPage("brief") }, { found: [inProject, loose] });
    render(<View {...props} />);
    await waitFor(() => expect(listRow("Budget")).toBeTruthy());
    fireEvent.contextMenu(listRow("Budget"));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Show in Its Folder" }));
    await waitFor(() => expect(calls(again, "work.files.tabSet").at(-1)?.params.page).toMatchObject({ at: { at: "place", id: "lifeos" }, name: "LifeOS" }));
  });

  it("offers Show in Its Folder on a LifeOS row in Recent and Starred too, and goes to its project", async () => {
    setLifeosStatus("box", st("connected"));
    // The host homes his marks' LifeOS rows as a search's results (places/lifeos.ts withLifeosHomes).
    const inProject: FileEntry = { ...brief, project: { id: "p1", name: "Fall season" }, where: { place: "lifeos", name: "LifeOS", trail: ["Fall season"] } };
    for (const lensId of ["recent", "starred"] as const) {
      const tab: FileTab = { id: "t1", kind: "page", name: lensId, page: { at: { at: "place", id: lensId }, name: lensId } };
      const host = standIn(tab, { lists: [() => ({ entries: [{ ...inProject, ...(lensId === "starred" ? { starred: true } : {}) }], trail: [] })] });
      render(<View {...props} />);
      await waitFor(() => expect(listRow("Sponsor brief")).toBeTruthy());
      fireEvent.contextMenu(listRow("Sponsor brief"));
      expect(await menuItems()).toContain("Show in Its Folder");
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Show in Its Folder" }));
      await waitFor(() => expect(calls(host, "work.files.tabSet").at(-1)?.params.page).toMatchObject({ at: { at: "project", id: "p1" }, name: "Fall season" }));
      cleanup();
      resetFilesStore();
    }
  });
});

describe("Recent and Starred while the host's LifeOS is down or on its way", () => {
  const recent: FileTab = { id: "t1", kind: "page", name: "Recent", page: { at: { at: "place", id: "recent" }, name: "Recent" } };

  it("says so once over the list, keeps a LifeOS row greyed and shut and the rest live, and opens it once LifeOS is back", async () => {
    setLifeosStatus("box", st("signed-out"));
    const host = standIn(recent, { lists: [() => ({ entries: [{ ...brief, starred: true }, row("Plan.docx")], trail: [] })] });
    render(<View {...props} />);
    await waitFor(() => expect(listRow("Sponsor brief")).toBeTruthy());
    await waitFor(() => expect(note()?.querySelector("[data-session-down]")?.textContent).toBe("Not signed in to LifeOS on the boxSign in"));
    expect(document.querySelectorAll("[data-files-note]")).toHaveLength(1);
    expect(listRow("Sponsor brief").getAttribute("aria-disabled")).toBe("true");
    expect(listRow("Plan.docx").getAttribute("aria-disabled")).toBeNull();
    fireEvent.doubleClick(listRow("Sponsor brief"));
    fireEvent.click(listRow("Sponsor brief"));
    fireEvent.keyDown(document.querySelector("[data-files-list]")!, { key: "Enter" });
    // Its menu offers nothing the session runs: no Open, no Share; his star stays his to take off.
    fireEvent.contextMenu(listRow("Sponsor brief"));
    const items = await menuItems();
    expect(items).not.toContain("Open");
    expect(items.some((i) => i.startsWith("Share"))).toBe(false);
    expect(items).toContain("Remove Star");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(opened(host)).toEqual([]);
    // On its way: the wait named with no press, the row still shut.
    act(() => setLifeosStatus("box", st("connecting")));
    expect(note()!.querySelector("[data-lifeos-waits]")!.textContent).toBe("LifeOS is still connecting on the box");
    expect(within(note()!).queryByRole("button")).toBeNull();
    expect(listRow("Sponsor brief").getAttribute("aria-disabled")).toBe("true");
    // A file on disk opens all along.
    fireEvent.doubleClick(listRow("Plan.docx"));
    await waitFor(() => expect(opened(host)).toEqual(["file"]));
    act(() => setLifeosStatus("box", st("connected")));
    await waitFor(() => expect(note()).toBeNull());
    expect(listRow("Sponsor brief").getAttribute("aria-disabled")).toBeNull();
    fireEvent.doubleClick(listRow("Sponsor brief"));
    await waitFor(() => expect(opened(host)).toEqual(["file", "lifeos"]));
  });

  it("greys and shuts the row in every shape of the page, as in the list", async () => {
    setLifeosStatus("box", st("connecting"));
    const host = standIn(recent, { lists: [() => ({ entries: [brief, row("Plan.docx")], trail: [] })] });
    render(<View {...props} />);
    await waitFor(() => expect(listRow("Sponsor brief")).toBeTruthy());
    for (const shape of ["grid", "beside", "gallery", "columns"]) {
      fireEvent.click(document.querySelector(`[data-files-shape=${shape}]`)!);
      await waitFor(() => expect([shape, listRow("Sponsor brief")?.getAttribute("aria-disabled"), document.querySelectorAll("[data-files-row]").length]).toEqual([shape, "true", 2]));
      expect(listRow("Plan.docx").getAttribute("aria-disabled")).toBeNull();
      fireEvent.doubleClick(listRow("Sponsor brief"));
    }
    expect(opened(host)).toEqual([]);
  });

  it("says nothing of LifeOS in Starred when none of its rows needs it", async () => {
    setLifeosStatus("box", st("signed-out"));
    standIn({ id: "t1", kind: "page", name: "Starred", page: { at: { at: "place", id: "starred" }, name: "Starred" } }, { lists: [() => ({ entries: [row("Plan.docx")], trail: [] })] });
    render(<View {...props} />);
    await waitFor(() => expect(listRow("Plan.docx")).toBeTruthy());
    expect(note()).toBeNull();
  });
});

describe("a folder whose read failed", () => {
  it("offers no New while nothing is listed, and offers it again once the folder lists", async () => {
    const answer = later<FilesListing>();
    const refused = (): never => {
      throw new Error("You may not read that folder.");
    };
    standIn({ id: "t1", kind: "page", name: "Dummy Esports", page: { at: { at: "place", id: "folder" }, name: "Dummy Esports" } }, { lists: [refused, () => answer.promise] });
    render(<View {...props} />);
    await waitFor(() => expect(screen.getByText("This folder did not load")).toBeTruthy());
    expect(within(page()).queryByRole("button", { name: "New" })).toBeNull();
    fireEvent.click(within(page()).getByRole("button", { name: "Retry" }));
    await act(async () => answer.settle({ entries: [row("Plan.docx")], trail: [] }));
    await waitFor(() => expect(listRow("Plan.docx")).toBeTruthy());
    expect(within(page()).getByRole("button", { name: "New" })).toBeTruthy();
  });
});

describe("each Retry spins on itself alone, in place, until the answer", () => {
  it("keeps \"The rest did not load\" with its Retry spinning until the rest lands", async () => {
    const rest = later<FilesListing>();
    const lost = (): never => {
      throw new Error("The box did not answer.");
    };
    standIn({ id: "t1", kind: "page", name: "Dummy Esports", page: { at: { at: "place", id: "folder" }, name: "Dummy Esports" } }, { lists: [() => ({ entries: [row("Plan.docx")], trail: [], next: "c1" }), lost, () => rest.promise] });
    render(<View {...props} />);
    await waitFor(() => expect(screen.getByText("The rest did not load")).toBeTruthy());
    fireEvent.click(within(page()).getByRole("button", { name: "Retry" }));
    expect(screen.getByText("The rest did not load")).toBeTruthy();
    const retry = within(page()).getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    await act(async () => rest.settle({ entries: [row("Notes.docx")], trail: [] }));
    await waitFor(() => expect(listRow("Notes.docx")).toBeTruthy());
    expect(screen.queryByText("The rest did not load")).toBeNull();
  });

  it("spins the LifeOS place's Retry for his press alone, never for a read the page asked by itself", async () => {
    setLifeosStatus("box", st("unreachable"));
    const read = later<FilesListing>();
    // The page's own first read is out.
    const host = standIn({ id: "t1", kind: "page", name: "LifeOS", page: { at: { at: "place", id: "lifeos" }, name: "LifeOS" } }, { lists: [() => read.promise] });
    render(<View {...props} />);
    await waitFor(() => expect(page().querySelector("[data-lifeos-down]")?.textContent).toBe("LifeOS did not answer the boxRetry"));
    await waitFor(() => expect(calls(host, "work.files.list").length).toBe(1));
    const retry = within(page()).getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(retry.querySelector("[data-busy]")).toBeNull();
    await act(async () => read.settle({ entries: [], trail: [] }));
  });

  it("spins a place's Retry until every host has answered its places again", async () => {
    const places = later<unknown>();
    let ask = 0;
    standIn({ id: "t1", kind: "page", name: "Gone", page: { at: { at: "place", id: "gone" }, name: "Gone" } }, { places: () => (++ask === 1 ? { host: "env_box", places: PLACES, rev: 1, sources: [] } : places.promise) });
    render(<View {...props} />);
    await waitFor(() => expect(screen.getByText("Gone is not here any more")).toBeTruthy());
    fireEvent.click(within(page()).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(ask).toBe(2));
    const retry = within(page()).getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    await act(async () => places.settle({ host: "env_box", places: PLACES, rev: 1, sources: [] }));
    await waitFor(() => expect(within(page()).getByRole("button", { name: "Retry" }).querySelector("[data-busy]")).toBeNull());
  });
});
