// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MacBridgeHostPolicy } from "@server/shared/contract-macbridge";

/**
 * "What <computer> may do on this Mac", its one sheet: the four levels each with its line, the confirms that guard
 * lowering it and the apps switch, the limits, the folders, and the one ask that opens it from anywhere.
 */

const calls: unknown[][] = [];
let fail: string | null = null;
let hosts: MacBridgeHostPolicy[] = [];
const act_ = (name: string) => async (...args: unknown[]) => {
  if (fail === name) throw new Error("refused: unknown computer: env_box");
  calls.push([name, ...args]);
};
vi.mock("../../../lib/macBridge", () => ({
  setMacBridgeComputer: act_("computer"),
  setMacBridgePolicy: act_("policy"),
  setMacBridgeLimits: act_("limits"),
  setMacBridgeShared: act_("shared"),
  refreshMacBridgeHosts: async () => hosts,
  refreshMacBridgeLoad: async () => null,
  useMacBridgeHosts: () => hosts,
  useMacBridgeRunning: () => [],
}));
vi.mock("../../../lib/macBridgeRules", () => ({ loadMacBridgeRules: async () => [], useMacBridgeRules: () => [] }));
vi.mock("../../../chrome/MacBridgeRunning", () => ({ MacBridgeRunningList: () => null }));
vi.mock("../../../chrome/MacBridgeRemember", () => ({ MacBridgeRuleList: () => null }));
vi.mock("../../../lib/portForwards", () => ({ useHostForwards: () => ({ enabled: true, forwards: [] }), setForwarding: act_("forwarding") }));
vi.mock("../../../lib/nativeWeb", () => ({ isWebMode: () => false }));
vi.mock("../../../lib/fs", () => ({ pickFolder: async () => null }));
const confirms: { title: string; body?: string }[] = [];
let confirmAnswer = true;
vi.mock("../../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<typeof import("../../../chrome/ConfirmDialog")>()),
  confirmAction: async (request: { title: string; body?: string }) => {
    confirms.push(request);
    return confirmAnswer;
  },
}));

const { MayBody, MaySheetHost, mayHereWords } = await import("./MaySheet");
const { openMaySheet } = await import("../../../lib/settings/maySheet");

const host = (over: Partial<MacBridgeHostPolicy> = {}): MacBridgeHostPolicy => ({
  environmentId: "env_box",
  name: "box",
  policy: "read+run",
  shared: ["/Users/me/shared"],
  showRunning: true,
  registered: true,
  maxRunning: 4,
  maxThreads: 2,
  running: 0,
  held: 0,
  threads: 0,
  computer: false,
  computerUnavailable: null,
  maxComputer: 2,
  computerLive: 0,
  ...over,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};
const draw = (over: Partial<MacBridgeHostPolicy> = {}) => render(<MayBody host={host(over)} name="The box" mac="this Mac" />);

afterEach(() => {
  cleanup();
  calls.length = 0;
  confirms.length = 0;
  confirmAnswer = true;
  fail = null;
  hosts = [];
});

describe("Files and commands", () => {
  it("is four choices, each with its own line, and a choice saves at once", async () => {
    draw({ policy: "read" });
    for (const line of ["Nothing on this Mac.", "Reads the folders it may and your projects; asks for the rest.", "Any file but keys and credentials."]) expect(screen.getByText(line)).toBeTruthy();
    fireEvent.click(screen.getByText("Full access"));
    await flush();
    expect(confirms).toEqual([]);
    expect(calls).toEqual([["policy", "env_box", "full"]]);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("asks before lowering it while its commands run, naming how many end", async () => {
    confirmAnswer = false;
    draw({ policy: "full", running: 2, held: 1 });
    fireEvent.click(screen.getByText("Read"));
    await flush();
    expect(confirms).toEqual([expect.objectContaining({ title: "Lower what The box may do on this Mac?", body: "3 commands it runs here end." })]);
    expect(calls).toEqual([]);
  });

  it("says why a refused change did not land", async () => {
    fail = "policy";
    draw({ policy: "read" });
    fireEvent.click(screen.getByText("Off"));
    await flush();
    expect(screen.getByText("Unknown computer: env_box")).toBeTruthy();
  });
});

describe("Use this Mac's apps", () => {
  it("is absent while Files and commands is Off", () => {
    draw({ policy: "off" });
    expect(document.querySelector("[data-setting='sharing.apps']")).toBeNull();
    expect(document.querySelector("[data-setting='sharing.folders']")).toBeNull();
  });

  it("asks before letting its threads use the apps, and turns nothing on when he declines", async () => {
    confirmAnswer = false;
    draw();
    fireEvent.click(screen.getByLabelText("Let The box use this Mac's apps"));
    await flush();
    expect(confirms[0]).toEqual(expect.objectContaining({ title: "Let The box use this Mac's apps?" }));
    expect(calls).toEqual([]);
    expect((screen.getByLabelText("Let The box use this Mac's apps") as HTMLElement).getAttribute("aria-checked")).toBe("false");
  });

  it("asks before turning it off while sessions are live, and not otherwise", async () => {
    draw({ computer: true, computerLive: 2 });
    fireEvent.click(screen.getByLabelText("Let The box use this Mac's apps"));
    await flush();
    expect(confirms[0]).toEqual(expect.objectContaining({ body: "2 live sessions end." }));
    expect(calls).toEqual([["computer", "env_box", false]]);
    cleanup();
    confirms.length = 0;
    draw({ computer: true });
    fireEvent.click(screen.getByLabelText("Let The box use this Mac's apps"));
    await flush();
    expect(confirms).toEqual([]);
  });
});

describe("the rest", () => {
  it("saves a limit, the dev sites and a folder, and removes a folder at once", async () => {
    draw({ computer: true });
    const commands = screen.getByLabelText("Commands The box runs here at once") as HTMLInputElement;
    fireEvent.change(commands, { target: { value: "6" } });
    fireEvent.blur(commands);
    fireEvent.click(screen.getByLabelText("Its dev sites open here"));
    fireEvent.change(screen.getByLabelText("A folder to read without asking"), { target: { value: "/tmp/a" } });
    fireEvent.click(screen.getByText("Add"));
    fireEvent.click(screen.getByText("Remove"));
    await flush();
    expect(calls).toEqual([
      ["limits", "env_box", { maxRunning: 6 }],
      ["forwarding", "env_box", false],
      ["shared", "env_box", ["/Users/me/shared", "/tmp/a"]],
      ["shared", "env_box", []],
    ]);
    expect(screen.getByLabelText("Apps The box drives here at once")).toBeTruthy();
  });

  it("opens for the computer one ask names, from anywhere", async () => {
    hosts = [host(), host({ environmentId: "env_pc", name: "PURDUE-LT", policy: "off" })];
    render(<MaySheetHost />);
    expect(document.querySelector("[data-may-sheet]")).toBeNull();
    act(() => openMaySheet("env_pc"));
    await flush();
    expect(document.querySelector("[data-may-sheet='env_pc']")).not.toBeNull();
    expect(screen.getByText("What PURDUE-LT may do on this Mac")).toBeTruthy();
  });

  it("sums up what a computer may do in a few words", () => {
    expect(mayHereWords({ policy: "read+run", computer: true })).toBe("Reads and runs commands, uses apps");
    expect(mayHereWords({ policy: "off", computer: true })).toBe("Nothing");
  });
});
