// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamsEntry, TeamsLibrary } from "@shared/contract-work-office";
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
const opened: string[] = [];
const T = "/c/S/Purdue Esports - Documents";
const LIB: TeamsLibrary = { id: "env_mac~1", host: "env_mac", path: T, team: "Purdue Esports", library: null, tenant: "Purdue University", kind: "channels", channels: ["General"], web: "https://p.sharepoint.com/sites/e/Shared Documents", found: true };
const entry = (name: string, over: Partial<TeamsEntry> = {}): TeamsEntry => ({ name, path: `${T}/General/${name}`, library: LIB.id, kind: name.endsWith(".pdf") ? "pdf" : name.endsWith(".xlsx") ? "workbook" : "folder", size: 10, modified: Date.now(), local: true, by: null, ...over });
const ENTRIES = [entry("Budgets"), entry("Budget.xlsx", { by: "Pat Lee" }), entry("Report.pdf", { local: false })];

const answer = (env: string, method: string, params: unknown): Promise<unknown> => {
  calls.push({ env, method, params });
  switch (method) {
    case "work.office.filesLibraries":
      if (macDown && env === "local") return Promise.reject(new Error("not connected"));
      return Promise.resolve({ libraries: env === "local" && !noLibs ? [LIB] : [], roots: [], off: [] });
    case "work.office.filesCopyGet":
      return Promise.resolve({ on: copyOn });
    case "work.office.filesList":
      return Promise.resolve({ entries: ENTRIES });
    case "work.office.filesSearch":
      if (searchFails) return Promise.reject(new Error("The host did not answer"));
      if (searchNone) return Promise.resolve({ entries: [], more: false });
      return Promise.resolve({ entries: env === "local" ? [entry("Budget.xlsx")] : [], more: false });
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
    case "work.canvas.open":
      return Promise.resolve({ item: { id: "i1" } });
  }
  return Promise.reject(new Error(`unexpected ${method}`));
};

vi.mock("../../lib/connection", () => ({
  LOCAL_ENVIRONMENT_ID: "local",
  registry: {
    has: (id: string) => id === "local" || id === "box",
    link: (id: string) => (id === "local" ? {} : undefined),
    environment: (id: string) => ({ id, name: id === "local" ? "This Mac" : "The box" }),
    linkOf: (env: string) => ({ environmentId: env, request: (method: string, params: unknown) => answer(env, method, params) }),
  },
}));
// The workspace's desktops are host ids: this Mac is env_mac on every host and "local" in its own window.
vi.mock("../shell/actions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  workspaceSettings: () => Promise.resolve({ mayUseDesktop: ["env_mac"] }),
  localHostId: () => Promise.resolve("env_mac"),
}));
vi.mock("../../lib/tcserver/store", () => ({ sessionStore: { adopt: vi.fn() } }));
vi.mock("../../lib/macBridge", () => ({ bridgeNewThread: () => Promise.resolve() }));
vi.mock("../../lib/workSwitch", () => ({ workOpenPort: { get: () => (id: string) => opened.push(id) }, workPlayPort: { get: () => null }, workViewNow: () => null }));

const { View, Head } = await import("./FilesView");

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
});
afterEach(cleanup);

const openGeneral = async (p: WorkViewProps) => {
  await act(async () => void render(<View {...p} />));
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "General" })));
  await screen.findByText("Report.pdf");
};

describe("the Files view", () => {
  it("lists a team's channels, then a folder with who and whether a file is downloaded", async () => {
    await openGeneral(props("local"));
    expect(screen.getByRole("button", { name: "Purdue Esports" })).toBeTruthy();
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
});
