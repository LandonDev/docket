// @vitest-environment jsdom
/**
 * Files' readers while the host's LifeOS is on its way, back, or a read is asked again (council round 11: Opus Files 1
 * and 2, Sol Files 1 and 2), each through the real Files view as the app mounts it, against a stand-in host:
 * - a search of every place says why LifeOS's rows are left out (the Search tab passes no copy: the search's own host
 *   carries it), waits with no press and no "Nothing found" while LifeOS connects, and searches again on return;
 * - Home makes no "Nothing here yet" claim while LifeOS connects, and says the wait with no press;
 * - Retry on "This folder did not load" keeps the failure with that Retry spinning until the answer; any other read of
 *   a failed folder draws the list's bones, never "This folder is empty";
 * - the LifeOS place, back since its read failed, draws the list's bones until it lists, never the old cause.
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
const LIFEOS = lens("lifeos", "lifeos", "LifeOS", { state: { state: "signed-out", detail: "LifeOS is not signed in on this host.", lifeos: "signed-out" }, can: ["make", "rename", "move", "edit"], makes: [] });
const PLACES: FilePlace[] = [lens("home", "home", "Home"), lens("recent", "recent", "Recent"), lens("starred", "starred", "Starred"), FOLDER, LIFEOS];
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
function standIn(tab: FileTab, o: { lists?: (() => FilesListing | Promise<FilesListing>)[]; searches?: SavedFileSearch[]; home?: FilesHome } = {}) {
  const lists = [...(o.lists ?? [])];
  const host: Host & { say(push: Push): void } = {
    calls: [],
    pushes: new Set(),
    say: (push) => host.pushes.forEach((listener) => listener(push)),
    answer(method) {
      switch (method) {
        case "work.files.places":
          return { host: "env_box", places: PLACES, rev: 1, sources: [] };
        case "work.office.filesCopyGet":
          return { on: false };
        case "work.files.tabs":
          return { rev: 1, tabs: [tab] };
        case "work.files.tabOpen":
          return { rev: 1, tabs: [tab], tabId: tab.id };
        case "work.files.searches":
          return { searches: o.searches ?? [] };
        case "work.files.search":
          return { entries: [], place: "search" } satisfies FilesListing;
        case "work.files.home":
          return o.home ?? { waiting: [], starred: [], recent: [] };
        case "work.files.list": {
          const next = lists.shift();
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

describe("a search of every place, through the real Search tab", () => {
  const tab: FileTab = { id: "t1", kind: "page", name: "Results for “plan”", page: searchPage("plan") };

  it("says why LifeOS's rows are left out, waits with no press and no claim while LifeOS connects, and searches again once it is back", async () => {
    setLifeosStatus("box", st("signed-out"));
    const host = standIn(tab);
    render(<View {...props} />);
    await waitFor(() => expect(note()?.querySelector("[data-session-down]")?.textContent).toBe("Not signed in to LifeOS on the boxSign in"));
    expect(screen.getByText("Nothing found")).toBeTruthy();
    // On its way: the wait named, no press, and the search makes no claim until LifeOS answers.
    act(() => setLifeosStatus("box", st("connecting")));
    expect(note()!.querySelector("[data-lifeos-waits]")!.textContent).toBe("LifeOS is still connecting on the box");
    expect(within(note()!).queryByRole("button")).toBeNull();
    expect(screen.queryByText("Nothing found")).toBeNull();
    expect(bones()).not.toBeNull();
    const asked = calls(host, "work.files.search").length;
    act(() => setLifeosStatus("box", st("connected")));
    await waitFor(() => expect(calls(host, "work.files.search").length).toBeGreaterThan(asked));
    await waitFor(() => expect(screen.getByText("Nothing found")).toBeTruthy());
    expect(note()).toBeNull();
  });

  it("says nothing of LifeOS for a search whose filter leaves LifeOS out", async () => {
    setLifeosStatus("box", st("connecting"));
    const saved: SavedFileSearch = { id: "s1", name: "On this computer", query: "plan", filter: { places: ["folder"] } };
    standIn({ id: "t1", kind: "page", name: saved.name, page: savedSearchPage(saved) }, { searches: [saved] });
    render(<View {...props} />);
    await waitFor(() => expect(screen.getByText("Nothing found")).toBeTruthy());
    expect(note()).toBeNull();
  });
});

describe("Home while the host's LifeOS connects", () => {
  it("names the wait with no press and claims no empty Home, then reads again once it is back", async () => {
    setLifeosStatus("box", st("connecting"));
    const host = standIn({ id: "t1", kind: "page", name: "Home", page: HOME_PAGE });
    render(<View {...props} />);
    await waitFor(() => expect(calls(host, "work.files.home").length).toBeGreaterThan(0));
    await waitFor(() => expect(note()?.querySelector("[data-lifeos-waits]")?.textContent).toBe("LifeOS is still connecting on the box"));
    expect(within(note()!).queryByRole("button")).toBeNull();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
    expect(bones()).not.toBeNull();
    const asked = calls(host, "work.files.home").length;
    act(() => setLifeosStatus("box", st("connected")));
    await waitFor(() => expect(calls(host, "work.files.home").length).toBeGreaterThan(asked));
    await waitFor(() => expect(screen.getByText("Nothing here yet")).toBeTruthy());
    expect(note()).toBeNull();
  });

  it("greys a starred or recent row only LifeOS opens, and keeps the rest live", async () => {
    setLifeosStatus("box", st("connecting"));
    const brief: FileEntry = { key: "lifeos:docs:1", ref: { at: "lifeos", table: "docs", id: "1" } as never, folder: null, name: "Brief", kind: "document" };
    standIn({ id: "t1", kind: "page", name: "Home", page: HOME_PAGE }, { home: { waiting: [], starred: [brief], recent: [row("Plan.docx")] } });
    render(<View {...props} />);
    const homeRow = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("[data-files-home-row]")].find((b) => b.textContent?.startsWith(name))!;
    await waitFor(() => expect(homeRow("Brief")).toBeTruthy());
    expect(homeRow("Brief").disabled).toBe(true);
    expect(homeRow("Plan.docx").disabled).toBe(false);
    act(() => setLifeosStatus("box", st("connected")));
    await waitFor(() => expect(homeRow("Brief").disabled).toBe(false));
  });
});

describe("a folder that did not load", () => {
  const tab: FileTab = { id: "t1", kind: "page", name: "Dummy Esports", page: { at: { at: "place", id: "folder" }, name: "Dummy Esports" } };
  const refused = (): never => {
    throw new Error("You may not read that folder.");
  };

  it("keeps the failure and its words with Retry spinning until the answer, never empty", async () => {
    const answer = later<FilesListing>();
    standIn(tab, { lists: [refused, () => answer.promise] });
    render(<View {...props} />);
    await waitFor(() => expect(screen.getByText("This folder did not load")).toBeTruthy());
    fireEvent.click(within(page()).getByRole("button", { name: "Retry" }));
    expect(screen.getByText("This folder did not load")).toBeTruthy();
    expect(screen.getByText("You may not read that folder.")).toBeTruthy();
    const retry = within(page()).getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    expect(screen.queryByText("This folder is empty")).toBeNull();
    await act(async () => answer.settle({ entries: [row("Plan.docx")], trail: [] }));
    await waitFor(() => expect(document.querySelector("[data-files-row]")?.textContent).toContain("Plan.docx"));
    expect(screen.queryByText("This folder did not load")).toBeNull();
  });

  it("draws the list's bones for any other read of it, never \"This folder is empty\"", async () => {
    const answer = later<FilesListing>();
    const host = standIn(tab, { lists: [refused, () => answer.promise] });
    render(<View {...props} />);
    await waitFor(() => expect(screen.getByText("This folder did not load")).toBeTruthy());
    // The host says the folder changed: it is read again, by no press of his.
    act(() => host.say({ push: "work.files", workspaceId: "w1", at: refKey(at("/w")) }));
    await waitFor(() => expect(bones()).not.toBeNull());
    expect(screen.queryByText("This folder is empty")).toBeNull();
    expect(screen.queryByText("This folder did not load")).toBeNull();
    await act(async () => answer.settle({ entries: [], trail: [] }));
    await waitFor(() => expect(screen.getByText("This folder is empty")).toBeTruthy());
  });
});

describe("the LifeOS place, back since its read failed", () => {
  it("draws the list's bones while it lists again, never the old cause, and offers no New meanwhile", async () => {
    setLifeosStatus("box", st("signed-out"));
    const answer = later<FilesListing>();
    const signedOut = (): never => {
      throw new Error("Not signed in to LifeOS on the box. Sign in under Settings, Connections.");
    };
    standIn({ id: "t1", kind: "page", name: "LifeOS", page: { at: { at: "place", id: "lifeos" }, name: "LifeOS" } }, { lists: [signedOut, () => answer.promise] });
    render(<View {...props} />);
    await waitFor(() => expect(page().querySelector("[data-lifeos-down]")?.textContent).toBe("Not signed in to LifeOS on the boxSign in"));
    act(() => setLifeosStatus("box", st("connected")));
    await waitFor(() => expect(bones()).not.toBeNull());
    expect(page().querySelector("[data-lifeos-down]")).toBeNull();
    expect(screen.queryByText("This folder did not load")).toBeNull();
    expect(screen.queryByText("This folder is empty")).toBeNull();
    expect(within(page()).queryByRole("button", { name: "New" })).toBeNull();
    await act(async () => answer.settle({ entries: [{ ...row("Brief"), key: "lifeos:docs:1" }], trail: [] }));
    await waitFor(() => expect(document.querySelector("[data-files-row]")?.textContent).toContain("Brief"));
    expect(bones()).toBeNull();
  });
});
