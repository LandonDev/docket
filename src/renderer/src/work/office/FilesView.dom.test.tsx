// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamsEntry, TeamsLibrary, TeamsPlace } from "@shared/contract-work-office";
import type { WorkViewProps } from "../views/registry";

/** The Files view over a fake host link: libraries, a folder, a cloud-only file opening in a new thread's canvas. */

const calls: { env: string; method: string; params: unknown }[] = [];
let copyOn = false;
let noLibs = false;
let copyFails = false;
let macDown = false;
let searchFails = false;
let searchNone = false;
let fetchGate: Promise<void> = Promise.resolve();
/** the workspace's own Work settings, as the host holds them */
let settings: { mayUseDesktop: string[]; windowsVm?: boolean } = { mayUseDesktop: ["env_mac"] };
/** what the box says of its places and the VM's libraries; null: a host on an older build, with no places */
let boxPlaces: TeamsPlace[] | null = null;
let vmLibs: TeamsLibrary[] = [];
let macPlaces: TeamsPlace[] | null = null;
/** the Mac's read of a folder fails as a machine out of reach */
let macListDown = false;
/** a host's list answers only once its gate opens (a host still being asked, or one that never answers) */
let hold: Record<string, Promise<void>> = {};
/** a host's search answers only once its gate opens */
let searchHold: Record<string, Promise<void>> = {};
const pushListeners = new Set<{ env: string; fn: (push: { push: string }) => void }>();
const pushFrom = (env: string, push: { push: string }) => [...pushListeners].filter((l) => l.env === env).forEach((l) => l.fn(push));
const signIns: string[] = [];
/** the threads the host says already hold a file (`work.office.filesThreads`), and which threads are archived */
let held: { sessionId: string; itemId: string }[] = [];
const archived = new Set<string>();
const opened: string[] = [];
const T = "/c/S/Purdue Esports - Documents";
const LIB: TeamsLibrary = { id: "env_mac~1", host: "env_mac", path: T, team: "Purdue Esports", library: null, tenant: "Purdue University", kind: "channels", channels: ["General"], web: "https://p.sharepoint.com/sites/e/Shared Documents", found: true };
const entry = (name: string, over: Partial<TeamsEntry> = {}): TeamsEntry => ({ name, path: `${T}/General/${name}`, library: LIB.id, kind: name.endsWith(".pdf") ? "pdf" : name.endsWith(".xlsx") ? "workbook" : "folder", size: 10, modified: Date.now(), local: true, by: null, ...over });
/** The RecWell site's Documents, whole, in the VM: the Mac syncs one of its folders by itself. */
const VM_LIB: TeamsLibrary = { id: "env_box~9", host: "env_box", path: "C:\\Users\\tcuser\\Purdue University\\RecWell - Documents", team: "RecWell", library: null, tenant: "Purdue University", kind: "channels", channels: ["Team RecWell", "Sport Programs"], web: null, found: true, vm: true };
const MAC_TEAM: TeamsLibrary = { id: "env_mac~7", host: "env_mac", path: "/c/OneDrive-purdue.edu-RecWell-TeamRecWell", team: "RecWell-TeamRecWell", library: null, tenant: "purdue.edu", kind: "library", channels: [], web: null, found: true };
const ENTRIES = [entry("Budgets"), entry("Budget.xlsx", { by: "Pat Lee" }), entry("Report.pdf", { local: false })];

const answer = (env: string, method: string, params: unknown): Promise<unknown> => {
  calls.push({ env, method, params });
  switch (method) {
    case "work.office.filesLibraries":
      return (hold[env] ?? Promise.resolve()).then(() => {
        if (macDown && env === "local") throw new Error("not connected");
        if (env === "box") return { host: "env_box", libraries: vmLibs, roots: [], off: [], ...(boxPlaces ? { places: boxPlaces } : {}) };
        return { host: "env_mac", libraries: !noLibs ? [LIB] : [], roots: [], off: [], ...(macPlaces ? { places: macPlaces } : {}) };
      });
    case "work.workspace.get":
      return Promise.resolve(settings);
    case "work.workspace.set":
      settings = { ...settings, ...(params as { patch: typeof settings }).patch };
      return Promise.resolve(settings);
    case "work.office.vmSignIn":
      signIns.push(env);
      return Promise.resolve({ computer: "vm:windows", account: "landon@purdue.edu", line: "Waiting for your approval" });
    case "work.office.filesCopyGet":
      return Promise.resolve({ on: copyOn });
    case "work.office.filesList": {
      const path = (params as { source: { path: string } }).source.path;
      if (env === "local" && macListDown) return Promise.reject(new Error("not connected"));
      if (path.startsWith("C:\\")) return Promise.resolve({ entries: [{ ...entry("From the VM.pdf"), path: `${path}\\From the VM.pdf`, library: VM_LIB.id }] });
      return Promise.resolve({ entries: ENTRIES });
    }
    case "work.office.filesSearch":
      return (searchHold[env] ?? Promise.resolve()).then(() => {
        if (searchFails) throw new Error("The host did not answer");
        return { entries: searchNone || env !== "local" ? [] : [entry("Budget.xlsx")], more: false };
      });
    case "work.office.filesFetch":
      return fetchGate.then(() => ({ entry: { ...(params as { source: { path: string } }) && entry("Report.pdf") } }));
    case "work.office.filesOpen":
      return Promise.resolve({ opened: true });
    case "session.create":
      return Promise.resolve({ id: "t1", title: (params as { title: string }).title });
    case "session.delete":
      return Promise.resolve({});
    case "work.office.filesCopy":
      if (copyFails) return Promise.reject(new Error("over 48 MB"));
      return Promise.resolve({ source: { at: "file", host: "env_box", path: "/box/attachments/teams-files/t1/Report.pdf" } });
    case "work.office.filesThreads":
      return Promise.resolve({ threads: held });
    case "work.canvas.open": {
      const { sessionId, itemId, kind = "document", source = null, title = "" } = params as { sessionId: string; itemId?: string; kind?: string; source?: unknown; title?: string };
      return Promise.resolve({ id: itemId ?? "i1", sessionId, workspaceId: null, kind, title, source, state: "open", position: 0, rev: 1, createdAt: 0, updatedAt: 0 });
    }
  }
  return Promise.reject(new Error(`unexpected ${method}`));
};

vi.mock("../../lib/connection", () => ({
  LOCAL_ENVIRONMENT_ID: "local",
  registry: {
    onLink: () => () => {},
    has: (id: string) => id === "local" || id === "box",
    link: (id: string) => (id === "local" ? { request: () => Promise.resolve({ environmentId: "env_mac" }) } : undefined),
    environment: (id: string) => ({ id, name: id === "local" ? "This Mac" : "The box" }),
    environments: () => [
      { id: "local", name: "This Mac", platform: "darwin" },
      { id: "box", name: "The box", platform: "linux" },
    ],
    linkOf: (env: string) => ({
      environmentId: env,
      request: (method: string, params: unknown) => answer(env, method, params),
      onPush: (fn: (push: { push: string }) => void) => {
        const l = { env, fn };
        pushListeners.add(l);
        return () => void pushListeners.delete(l);
      },
    }),
  },
}));
// The workspace's desktops are host ids: this Mac is env_mac on every host and "local" in its own window.
vi.mock("../shell/actions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  localHostId: () => Promise.resolve("env_mac"),
}));
const stage: unknown[] = [];
let computersOpened = 0;
vi.mock("../../lib/popOut", () => ({ requestStage: (c: unknown) => stage.push(c) }));
vi.mock("../../stores/shell", () => ({ shell: { openComputers: () => void computersOpened++, openSettings: vi.fn() } }));
vi.mock("../../lib/tcserver/store", () => ({ sessionStore: { adopt: vi.fn(), metaOf: (id: string) => ({ id, archived: archived.has(id) }) } }));
vi.mock("../../lib/macBridge", () => ({ bridgeNewThread: () => Promise.resolve() }));
vi.mock("../../lib/workSwitch", () => ({ workOpenPort: { get: () => (id: string) => opened.push(id) }, workPlayPort: { get: () => null }, workViewNow: () => null }));

const { View, Head } = await import("./FilesView");
const { canvasOf, resetCanvasStore } = await import("../canvas/store");

const props = (environmentId: string): WorkViewProps =>
  ({ env: environmentId, workspace: { id: `w-${environmentId}-${Math.random()}`, environmentId, path: "/w", name: "Purdue", kind: "work" }, sector: "purdue", lifeos: {}, startThread: () => {} }) as unknown as WorkViewProps;

beforeEach(() => {
  calls.length = 0;
  opened.length = 0;
  copyOn = false;
  noLibs = false;
  copyFails = false;
  macDown = false;
  searchFails = false;
  searchNone = false;
  fetchGate = Promise.resolve();
  settings = { mayUseDesktop: ["env_mac"] };
  boxPlaces = null;
  macPlaces = null;
  vmLibs = [];
  macListDown = false;
  signIns.length = 0;
  held = [];
  archived.clear();
  resetCanvasStore();
  hold = {};
  searchHold = {};
  pushListeners.clear();
  stage.length = 0;
  computersOpened = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const openGeneral = async (p: WorkViewProps) => {
  await act(async () => void render(<View {...p} />));
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "General" })));
  await screen.findByText("Report.pdf");
};

describe("the Files view", () => {
  it("lists a team's channels, then a folder with who and whether a file is downloaded", async () => {
    await openGeneral(props("local"));
    expect(screen.getByText("Purdue Esports")).toBeTruthy();
    expect(screen.getByText("General", { selector: "[aria-current]" })).toBeTruthy();
    expect(screen.getByText("Pat Lee")).toBeTruthy();
    expect(screen.getAllByLabelText("In the cloud")).toHaveLength(1);
    expect(calls.find((c) => c.method === "work.office.filesList")?.params).toEqual({ source: { at: "file", host: "env_mac", path: `${T}/General` } });
  });

  it("downloads a cloud-only file in its row, then opens it in a new thread's canvas on its own host", async () => {
    let release!: () => void;
    fetchGate = new Promise((done) => (release = done));
    await openGeneral(props("local"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Report\.pdf/ })));
    expect(screen.getByText("Downloading…")).toBeTruthy();
    await act(async () => release());
    expect(calls.map((c) => c.method).slice(-3)).toEqual(["work.office.filesFetch", "session.create", "work.canvas.open"]);
    expect(calls.at(-1)!.params).toMatchObject({ sessionId: "t1", kind: "pdf", source: { at: "file", host: "env_mac" }, title: "Report.pdf" });
    expect(opened).toEqual(["t1"]);
  });

  // The owner, 2026-11-23: opening a file went to a new chat with no viewer. The file takes the pane, the thread folded beside it.
  it("shows the file it opened at once: the item selected in its thread and the thread folded away", async () => {
    await openGeneral(props("local"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Budget\.xlsx/ })));
    const view = canvasOf("t1");
    expect(view.items.map((i) => [i.id, i.kind, i.title])).toEqual([["i1", "sheet", "Budget.xlsx"]]);
    expect(view.selected).toBe("i1");
    expect(view.folded).toBe(true);
    expect(opened).toEqual(["t1"]);
  });

  it("opens a file again in the thread that already holds it, passing over an archived one", async () => {
    copyOn = true;
    held = [
      { sessionId: "t-old", itemId: "i-old" },
      { sessionId: "t0", itemId: "i0" },
    ];
    archived.add("t-old");
    await openGeneral(props("box"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Report\.pdf/ })));
    expect(calls.find((c) => c.method === "work.office.filesThreads")).toMatchObject({ env: "box", params: { source: { at: "file", host: "env_mac", path: `${T}/General/Report.pdf` } } });
    expect(calls.some((c) => c.method === "session.create" || c.method === "work.office.filesCopy")).toBe(false);
    expect(calls.at(-1)).toMatchObject({ method: "work.canvas.open", params: { sessionId: "t0", itemId: "i0" } });
    expect(canvasOf("t0")).toMatchObject({ selected: "i0", folded: true });
    expect(opened).toEqual(["t0"]);
  });

  it("from a workspace on another host with no copy allowed, opens the file in its app where it lies", async () => {
    await openGeneral(props("box"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Budget\.xlsx/ })));
    expect(calls.filter((c) => c.method === "work.office.filesOpen").map((c) => c.env)).toEqual(["local"]);
    expect(calls.some((c) => c.method === "session.create" || c.method === "work.office.filesCopy")).toBe(false);
  });

  it("with the copy he allowed, copies the file to the thread and opens the copy", async () => {
    copyOn = true;
    await openGeneral(props("box"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Report\.pdf/ })));
    expect(calls.find((c) => c.method === "work.office.filesCopy")).toMatchObject({ env: "box", params: { sessionId: "t1" } });
    expect(calls.at(-1)!.params).toMatchObject({ kind: "pdf", source: { at: "file", host: "env_box", path: "/box/attachments/teams-files/t1/Report.pdf" } });
  });

  it("takes a thread made for a copy back out when the copy fails", async () => {
    copyOn = true;
    copyFails = true;
    await openGeneral(props("box"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Report\.pdf/ })));
    expect(calls.map((c) => c.method).slice(-3)).toEqual(["session.create", "work.office.filesCopy", "session.delete"]);
    expect(opened).toEqual([]);
  });

  it("searches every library from the header", async () => {
    const p = props("local");
    await act(async () => void render(<><Head {...p} /><View {...p} /></>));
    await act(async () => fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "budget" } }));
    expect(await screen.findByText("Purdue Esports/General", {}, { timeout: 2000 })).toBeTruthy();
    expect(calls.filter((c) => c.method === "work.office.filesSearch").map((c) => c.params)).toContainEqual({ query: "budget" });
  });

  it("says when nothing is synced", async () => {
    noLibs = true;
    await act(async () => void render(<View {...props("box")} />));
    expect(await screen.findByText("No Teams files")).toBeTruthy();
  });

  it("says a desktop that did not answer on the state line with Retry, and never calls that no Teams files", async () => {
    macDown = true;
    await act(async () => void render(<View {...props("box")} />));
    const line = await screen.findByRole("status");
    expect(line.getAttribute("data-view-state")).toBe("failed");
    expect(line.textContent).toContain("This Mac did not answer");
    expect(screen.queryByText("No Teams files")).toBeNull();
    macDown = false;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(await screen.findByText("Purdue Esports")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers Retry when a search did not run, and says no match in one line", async () => {
    searchFails = true;
    const p = props("local");
    await act(async () => void render(<><Head {...p} /><View {...p} /></>));
    await act(async () => fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "budget" } }));
    expect(await screen.findByText("Search did not run", {}, { timeout: 2000 })).toBeTruthy();
    searchFails = false;
    searchNone = true;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(await screen.findByText("No files match", {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByText(/Nothing is named/)).toBeNull();
  });

  it("has the same search field as Docs: its ×, and narrower under a 640px header", async () => {
    const p = props("local");
    render(<Head {...p} />);
    const field = screen.getByRole("search");
    expect(field.className).toContain("@max-[640px]/viewhead:w-40");
    fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect((screen.getByLabelText("Search files") as HTMLInputElement).value).toBe("");
  });
  it("a workspace that may use no computer yet says so, and one press lets it use his desktops and the VM, then lists", async () => {
    settings = { mayUseDesktop: [] };
    boxPlaces = [{ kind: "vm", state: "ok", account: "landon@purdue.edu" }];
    await act(async () => void render(<View {...props("box")} />));
    expect(await screen.findByText("This workspace can't use your computers yet")).toBeTruthy();
    expect(screen.getByText("Allow This Mac and the Windows VM to list your Teams files.")).toBeTruthy();
    expect(screen.queryByText(/Sync a channel/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow" })));
    expect(settings).toEqual({ mayUseDesktop: ["env_mac"], windowsVm: true });
    expect(await screen.findByText("Purdue Esports")).toBeTruthy();
  });

  it("with the Mac the only place and nothing synced there, gives the old advice and names the Mac", async () => {
    noLibs = true;
    macPlaces = [{ kind: "folders", state: "no-libraries", account: "landon@purdue.edu" }];
    await act(async () => void render(<View {...props("box")} />));
    expect(await screen.findByText("No Teams files on This Mac")).toBeTruthy();
    expect(screen.getByText("Sync a channel from Teams with OneDrive there.")).toBeTruthy();
  });

  it("with OneDrive signed out in the VM and nothing else, offers its sign-in, then the Computers page on the VM", async () => {
    settings = { mayUseDesktop: [], windowsVm: true };
    boxPlaces = [{ kind: "vm", state: "signed-out", account: null }];
    await act(async () => void render(<View {...props("box")} />));
    expect(await screen.findByText("OneDrive on the Windows VM is signed out")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to OneDrive" })));
    expect(signIns).toEqual(["box"]);
    expect(stage).toEqual([{ host: "box", threadId: "vm:windows" }]);
    expect(computersOpened).toBe(1);
  });

  it("with the Mac listing and the VM signed out, lists as usual with one quiet line naming the fix", async () => {
    settings = { mayUseDesktop: ["env_mac"], windowsVm: true };
    boxPlaces = [{ kind: "vm", state: "signed-out", account: null }];
    await act(async () => void render(<View {...props("box")} />));
    expect(await screen.findByText("Purdue Esports")).toBeTruthy();
    expect(screen.getByText("OneDrive on the Windows VM is signed out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in to OneDrive" })).toBeTruthy();
  });

  it("shows a folder the Mac and the VM both hold once, under the VM's team, and reads it from the VM first", async () => {
    settings = { mayUseDesktop: ["env_mac"], windowsVm: true };
    boxPlaces = [{ kind: "vm", state: "ok", account: "landon@purdue.edu" }];
    vmLibs = [VM_LIB];
    noLibs = false;
    const LIB_BEFORE = { ...LIB };
    Object.assign(LIB, MAC_TEAM);
    try {
      await act(async () => void render(<View {...props("box")} />));
      expect(await screen.findByText("RecWell")).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Team RecWell" })).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Sport Programs" })).toBeTruthy();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Team RecWell" })));
      expect(await screen.findByText("From the VM.pdf")).toBeTruthy();
      expect(calls.filter((c) => c.method === "work.office.filesList").map((c) => [c.env, (c.params as { source: { path: string } }).source.path])).toEqual([["box", `${VM_LIB.path}\\Team RecWell`]]);
    } finally {
      Object.assign(LIB, LIB_BEFORE);
    }
  });

  it("reads a folder from the next copy, at the same place, when the first machine is out of reach, and never a VM library while its switch is off", async () => {
    settings = { mayUseDesktop: ["env_mac"], windowsVm: false };
    boxPlaces = [{ kind: "vm", state: "ok", account: "landon@purdue.edu" }];
    vmLibs = [VM_LIB];
    await act(async () => void render(<View {...props("box")} />));
    expect(await screen.findByText("Purdue Esports")).toBeTruthy();
    expect(screen.queryByText("RecWell")).toBeNull();
    cleanup();
    // Mac out of reach for a read: a place both hold is read from the VM at the same folder.
    settings = { mayUseDesktop: ["env_mac"], windowsVm: true };
    const LIB_BEFORE = { ...LIB };
    Object.assign(LIB, MAC_TEAM);
    boxPlaces = [{ kind: "vm", state: "error", account: null, detail: "asleep" }];
    macListDown = true;
    try {
      await act(async () => void render(<View {...props("box")} />));
      await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Team RecWell" })));
      expect(await screen.findByText("From the VM.pdf")).toBeTruthy();
      expect(calls.filter((c) => c.method === "work.office.filesList").map((c) => c.env)).toEqual(["local", "box"]);
    } finally {
      Object.assign(LIB, LIB_BEFORE);
    }
  });

  it("opens a file in the VM in its app there, or as a copy he allowed: never in the canvas on its own host", async () => {
    settings = { mayUseDesktop: [], windowsVm: true };
    boxPlaces = [{ kind: "vm", state: "ok", account: "landon@purdue.edu" }];
    vmLibs = [VM_LIB];
    await act(async () => void render(<View {...props("box")} />));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Team RecWell" })));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: /^From the VM\.pdf/ })));
    expect(calls.filter((c) => c.method === "work.office.filesOpen").map((c) => c.env)).toEqual(["box"]);
    expect(calls.some((c) => c.method === "session.create")).toBe(false);
  });

  it("paints a host that answered while another is still being asked, with bones under its rows for the rest", async () => {
    settings = { mayUseDesktop: ["env_mac"], windowsVm: true };
    let open = () => {};
    hold = { box: new Promise<void>((done) => (open = done)) };
    vmLibs = [VM_LIB];
    boxPlaces = [{ kind: "vm", state: "ok", account: "landon@purdue.edu" }];
    const { container } = await act(async () => render(<View {...props("box")} />));
    expect(await screen.findByText("Purdue Esports")).toBeTruthy();
    expect(screen.queryByText("RecWell")).toBeNull();
    expect(container.querySelector("[aria-busy]")).toBeTruthy();
    await act(async () => open());
    expect(await screen.findByText("RecWell")).toBeTruthy();
    expect(container.querySelector("[aria-busy]")).toBeNull();
  });

  it("says a host past its deadline is not answering, over what the others listed, and Retry asks it again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    settings = { mayUseDesktop: ["env_mac"], windowsVm: true };
    hold = { box: new Promise<void>(() => {}) };
    await act(async () => void render(<View {...props("box")} />));
    expect(await screen.findByText("Purdue Esports")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => void vi.advanceTimersByTime(4_000));
    const line = await screen.findByRole("status");
    expect(line.textContent).toContain("The box did not answer");
    hold = {};
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(await screen.findByText("Purdue Esports")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a host that answers after its deadline takes the place of the line that said it did not", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    settings = { mayUseDesktop: ["env_mac"], windowsVm: true };
    let open = () => {};
    hold = { box: new Promise<void>((done) => (open = done)) };
    vmLibs = [VM_LIB];
    boxPlaces = [{ kind: "vm", state: "ok", account: "landon@purdue.edu" }];
    await act(async () => void render(<View {...props("box")} />));
    await act(async () => void vi.advanceTimersByTime(4_000));
    expect((await screen.findByRole("status")).textContent).toContain("The box did not answer");
    await act(async () => open());
    expect(await screen.findByText("RecWell")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("holds the bones while the VM is read for the first time, and paints what the read found when its host pushes", async () => {
    settings = { mayUseDesktop: [], windowsVm: true };
    boxPlaces = [{ kind: "vm", state: "reading", account: null }];
    const { container } = await act(async () => render(<View {...props("box")} />));
    await act(async () => void (await Promise.resolve()));
    expect(container.querySelector("[aria-busy]")).toBeTruthy();
    expect(screen.queryByText(/No Teams files|did not load/)).toBeNull();
    boxPlaces = [{ kind: "vm", state: "ok", account: "landon@purdue.edu" }];
    vmLibs = [VM_LIB];
    await act(async () => pushFrom("box", { push: "work.office.files" }));
    expect(await screen.findByText("RecWell")).toBeTruthy();
    expect(calls.filter((c) => c.method === "work.office.filesLibraries" && c.env === "box")).toHaveLength(2);
  });

  it("says a VM helper that did not answer on the state line, with its words, over the libraries it kept", async () => {
    settings = { mayUseDesktop: [], windowsVm: true };
    boxPlaces = [{ kind: "vm", state: "error", account: "landon@purdue.edu", detail: "The Office helper did not answer" }];
    vmLibs = [VM_LIB];
    await act(async () => void render(<View {...props("box")} />));
    expect(await screen.findByText("RecWell")).toBeTruthy();
    const line = screen.getByRole("status");
    expect(line.textContent).toContain("The Windows VM did not answer");
    expect(line.textContent).toContain("The Office helper did not answer");
  });

  it("shows the hits of a host that answered a search while another is still searching", async () => {
    settings = { mayUseDesktop: ["env_mac"], windowsVm: true };
    boxPlaces = [{ kind: "vm", state: "ok", account: "landon@purdue.edu" }];
    vmLibs = [VM_LIB];
    searchHold = { box: new Promise<void>(() => {}) };
    const p = props("box");
    const { container } = await act(async () => render(<><Head {...p} /><View {...p} /></>));
    expect(await screen.findByText("Purdue Esports")).toBeTruthy();
    await act(async () => fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "budget" } }));
    expect(await screen.findByText("Purdue Esports/General", {}, { timeout: 2000 })).toBeTruthy();
    expect(container.querySelector("[aria-busy]")).toBeTruthy();
    expect(calls.filter((c) => c.method === "work.office.filesSearch").map((c) => c.env).sort()).toEqual(["box", "local"]);
  });
});
