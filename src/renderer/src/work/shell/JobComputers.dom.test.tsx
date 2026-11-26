// @vitest-environment jsdom
/**
 * A job's "Computers its threads may use" (docs/agents/settings.md "The pages: jobs, workspaces, Archive"): each
 * computer by its one name, a switch each, and where the job allows a computer that itself refuses the job's computer,
 * the amber line naming the machine and where to change it.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";

vi.mock("../../lib/connection", async (original) => {
  const real = await original<typeof import("../../lib/connection")>();
  return {
    ...real,
    useEnvironments: () => [
      { id: "local", name: "This Mac", platform: "darwin" },
      { id: "env_box", name: "The box", platform: "linux" },
      { id: "env_pc", name: "PURDUE-LT", platform: "win32" },
    ],
  };
});
vi.mock("../rules/HouseRules", () => ({ HouseRules: () => null, VoiceRow: () => null }));
vi.mock("../mail/WaitingSection", () => ({ WaitingRows: () => null }));
vi.mock("../office/TeamsCopyRow", () => ({ TeamsCopyRow: () => null }));
vi.mock("../../surfaces/settings/parts/StartSetRow", () => ({ StartSetRow: () => null }));
vi.mock("../../lib/tcserver/workspaces", async (original) => ({
  ...(await original<object>()),
  useWorkspaces: () => [{ id: "ws", name: "Purdue Esports", environmentId: "env_box", sector: "purdue", kind: "work", path: "/w" }],
}));
const job = vi.hoisted(() => ({ may: ["env_mac", "env_pc"] as string[], writes: [] as unknown[] }));
vi.mock("./actions", async (original) => ({
  ...(await original<object>()),
  workspaceSettings: async () => ({ mayUseDesktop: job.may, model: null, reasoning: null, voice: false }),
  setWorkspaceSettings: async (_ws: unknown, patch: { mayUseDesktop?: string[] }) => {
    job.writes.push(patch);
    if (patch.mayUseDesktop) job.may = patch.mayUseDesktop;
    return { mayUseDesktop: job.may, model: null, reasoning: null, voice: false };
  },
  hostDesktops: async () => [],
  localHostId: async () => "env_mac",
}));
// This Mac's own bridge: what it lets the box do.
const bridge = vi.hoisted(() => ({ policy: "off" as string }));
vi.mock("../../lib/macBridge", async (original) => ({
  ...(await original<object>()),
  useMacBridgeHosts: () => [{ environmentId: "env_box", name: "The box", policy: bridge.policy }],
  refreshMacBridgeHosts: async () => [],
}));
const requestSettings = vi.hoisted(() => vi.fn());
vi.mock("../../lib/monaco/debugTab", async (original) => ({ ...(await original<object>()), requestSettings }));
/** The computers whose sheet was asked for (lib/settings/maySheet.ts). */
const asked: string[] = [];
window.addEventListener("docket:settings-may-sheet", (event) => asked.push((event as CustomEvent<string>).detail));
vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));

const { resetOwnComputerForTests } = await import("../../lib/settings/computerName");
const { WorkWorkspacePage } = await import("./JobSettings");

/** The PC's own activity read, over its link: what it lets the box do. */
const pc = { policy: "off" };
const fakeLink = (id: string) =>
  ({
    environmentId: id,
    connected: true,
    request: vi.fn(async (method: string) => (method === "macBridge.activity" ? { hosts: [{ environmentId: "env_box", name: "The box", policy: pc.policy }], load: {}, calls: [], at: 1 } : {})),
    onPush: () => () => {},
    onOpen: () => () => {},
  }) as never;

beforeEach(() => {
  resetOwnComputerForTests("MacBook-Pro");
  job.may = ["env_mac", "env_pc"];
  job.writes = [];
  bridge.policy = "off";
  pc.policy = "off";
  vi.spyOn(registry, "link").mockImplementation((id: string) => fakeLink(id));
  vi.spyOn(registry, "linkOf").mockImplementation((id: string) => fakeLink(id));
  vi.spyOn(registry, "has").mockImplementation((id: string) => id === "env_box" || id === "env_pc");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  requestSettings.mockClear();
  asked.length = 0;
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const rowOf = (name: string) => screen.getByRole("switch", { name }).closest<HTMLElement>("[data-slot=page-row]")!;

describe("a job's computers", () => {
  it("names each computer once, this window's own with this Mac after it", async () => {
    render(<WorkWorkspacePage workspaceId="ws" />);
    await settle();
    expect(rowOf("MacBook-Pro").textContent).toContain("MacBook-Prothis Mac");
    expect(rowOf("PURDUE-LT")).toBeTruthy();
  });

  it("shows the amber line under a computer whose bridge is Off for the job's computer, and Open Sharing asks for that row", async () => {
    render(<WorkWorkspacePage workspaceId="ws" />);
    await settle();
    const mac = rowOf("MacBook-Pro").querySelector("[data-refusal]");
    expect(mac?.textContent).toContain("This Mac gives the box no access.");
    fireEvent.click(screen.getByRole("button", { name: "Open Sharing" }));
    // Sharing opens with what the box may do on this Mac over it: the rule that refuses, one press from its switch.
    expect(requestSettings).toHaveBeenCalledWith("sharing", "sharing.may");
    expect(asked).toEqual(["env_box"]);
    // Another computer's refusal changes on that computer: words alone, no press.
    expect(rowOf("PURDUE-LT").querySelector("[data-refusal]")?.textContent).toBe("PURDUE-LT gives the box no access. Change it on PURDUE-LT, under Sharing.");
    expect(screen.getAllByRole("button", { name: "Open Sharing" })).toHaveLength(1);
  });

  it("says nothing where the bridge lets the job's computer in, or where the job does not allow that computer", async () => {
    bridge.policy = "read+run";
    job.may = ["env_mac"];
    render(<WorkWorkspacePage workspaceId="ws" />);
    await settle();
    expect(document.querySelector("[data-refusal]")).toBeNull();
  });

  it("writes the job's list of host ids on a flip, this Mac by its host id", async () => {
    render(<WorkWorkspacePage workspaceId="ws" />);
    await settle();
    fireEvent.click(screen.getByRole("switch", { name: "MacBook-Pro" }));
    await settle();
    expect(job.writes).toEqual([{ mayUseDesktop: ["env_pc"] }]);
    expect(screen.getByRole("switch", { name: "MacBook-Pro" }).getAttribute("aria-checked")).toBe("false");
  });
});
