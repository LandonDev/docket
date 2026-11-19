// @vitest-environment jsdom
/** Settings → Work's LifeOS row: "LifeOS did not answer" offers Retry, which asks the host again. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { resetLifeos, setLifeosStatus } from "./lifeos";

vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  useEnvironments: () => [{ id: "env_box", name: "The box", platform: "linux" }],
}));
// The rows under LifeOS are what this test reads; the sections after it stand still.
vi.mock("../formats/ToolchainRow", () => ({ ToolchainRow: () => null }));
vi.mock("../office/AddinRow", () => ({ AddinRow: () => null }));
vi.mock("../guests/GuestLinksSection", () => ({ GuestLinksSection: () => null }));
vi.mock("../rules/HouseRules", () => ({ HouseRules: () => null }));
vi.mock("../../chrome/ThreadDefaultsDialog", async (original) => ({ ...(await original<object>()), ThreadDefaultsEditor: () => null }));
vi.mock("../../lib/tcserver/workspaces", async (original) => ({
  ...(await original<object>()),
  useWorkspaces: () => [{ id: "ws", name: "Purdue Esports", environmentId: "env_box", sector: "purdue", kind: "work", path: "/w" }],
}));
const reads = vi.hoisted(() => ({ fail: true, asked: 0 }));
vi.mock("./actions", async (original) => ({
  ...(await original<object>()),
  workspaceSettings: async () => {
    reads.asked++;
    if (reads.fail) throw new Error("The host did not answer");
    return { mayUseDesktop: [], model: null, reasoning: null, voice: false };
  },
}));

const { LifeosHostRow, WorkSettingsBody, WorkWorkspacePage } = await import("./settings");

afterEach(() => {
  cleanup();
  resetLifeos();
  workSwitch.reset();
  vi.restoreAllMocks();
});

describe("a host's LifeOS row", () => {
  it("shows Retry while LifeOS does not answer, and Retry asks the host for its status", async () => {
    const request = vi.fn(async () => ({ lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request, onPush: () => () => {}, onOpen: () => () => {} } as never);
    setLifeosStatus("env_box", { lifeos: { state: "unreachable", since: Date.UTC(2026, 10, 19, 14), error: "timeout" }, keys: [] });
    render(<LifeosHostRow environmentId="env_box" name="LifeOS" />);
    expect(screen.getByText(/^LifeOS did not answer/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(request).toHaveBeenCalledWith("work.lifeos.status");
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps the line and says why when Retry gets no answer either", async () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(async () => Promise.reject(new Error("The host did not answer"))), onPush: () => () => {}, onOpen: () => () => {} } as never);
    setLifeosStatus("env_box", { lifeos: { state: "unreachable", since: Date.UTC(2026, 10, 19, 14), error: "timeout" }, keys: [] });
    render(<LifeosHostRow environmentId="env_box" name="LifeOS" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.getByText(/^LifeOS did not answer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("titles the row with the host's name, with one host as with two, never a second LifeOS under the heading", () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(async () => ({})), onPush: () => () => {}, onOpen: () => () => {} } as never);
    setWorkOn("env_box", true);
    setLifeosStatus("env_box", { lifeos: { state: "signed-out" }, keys: [] });
    render(<WorkSettingsBody />);
    expect(screen.getByText("The box")).toBeTruthy();
    expect(screen.getAllByText("LifeOS")).toHaveLength(1);
  });

  it("a workspace page whose settings did not load offers Retry, which reads them again", async () => {
    reads.fail = true;
    reads.asked = 0;
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(async () => ({ lifeos: { state: "signed-out" }, keys: [] })), onPush: () => () => {}, onOpen: () => () => {} } as never);
    render(<WorkWorkspacePage workspaceId="ws" />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.getByText("The host did not answer")).toBeTruthy();
    reads.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(reads.asked).toBe(2);
    expect(screen.queryByText("The host did not answer")).toBeNull();
  });
});
