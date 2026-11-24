// @vitest-environment jsdom
/** Settings → Work: each host's LifeOS sign-in lives on Connections now, and a workspace page's failed read offers Retry. */
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
vi.mock("../office/AddinRow", () => ({ AddinRow: () => null }));
vi.mock("../guests/GuestLinksSection", () => ({ GuestLinksSection: () => null }));
vi.mock("../rules/HouseRules", () => ({ HouseRules: () => null }));
vi.mock("../../chrome/ThreadDefaultsDialog", async (original) => ({ ...(await original<object>()), ThreadDefaultsEditor: () => <div data-defaults /> }));
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
  // The box knows the PC paired to it alone; this window (the Mac's) has no link to it.
  hostDesktops: async () => [{ id: "env_pc", name: "PURDUE-LT", platform: "win32" }],
  localHostId: async () => "env_mac",
}));

vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));
const { GIVEN_KEY, OWNER_KEY, resetTestKey, testKey } = await import("../../lib/linkMay.testkit");
const { SignInDialog, WorkSettingsBody, WorkWorkspacePage } = await import("./settings");

afterEach(() => {
  cleanup();
  resetLifeos();
  workSwitch.reset();
  vi.restoreAllMocks();
  resetTestKey();
});

describe("Settings → Work", () => {
  it("says no host's LifeOS sign-in, since Connections holds it", () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(async () => ({})), onPush: () => () => {}, onOpen: () => () => {} } as never);
    setWorkOn("env_box", true);
    setLifeosStatus("env_box", { lifeos: { state: "signed-out" }, keys: [] });
    render(<WorkSettingsBody />);
    expect(screen.queryByText("The box")).toBeNull();
    expect(screen.queryByText("Not signed in")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in…" })).toBeNull();
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

  it("draws Computer use on a PC the workspace's host knows, though this window has no link to it", async () => {
    reads.fail = false;
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(async () => ({ lifeos: { state: "signed-out" }, keys: [] })), onPush: () => () => {}, onOpen: () => () => {} } as never);
    render(<WorkWorkspacePage workspaceId="ws" />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.getByRole("switch", { name: "Computer use on PURDUE-LT" })).toBeTruthy();
  });
});

describe("a workspace page for a key that may not change it", () => {
  it("a given computer's key sees one line where the switches were, and writes nothing", async () => {
    reads.fail = false;
    testKey.current = GIVEN_KEY;
    const request = vi.fn(async () => ({ lifeos: { state: "signed-out" }, keys: [] }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request, onPush: () => () => {}, onOpen: () => () => {} } as never);
    render(<WorkWorkspacePage workspaceId="ws" />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.queryAllByRole("switch")).toEqual([]);
    expect(document.querySelector("[data-defaults]")).toBeNull();
    expect(screen.getAllByText("Changed from a computer that manages The box")).toHaveLength(1);
    expect(request.mock.calls.map((c: unknown[]) => c[0]).filter((m) => m === "work.workspace.set" || m === "work.mail.waiting")).toEqual([]);
  });
});

describe("Sign in to LifeOS", () => {
  const host = (id: string) =>
    vi.spyOn(registry, "linkOf").mockReturnValue({
      environmentId: id,
      connected: true,
      request: vi.fn(() => Promise.resolve({ code: "ABCD-1234", expiresAt: Date.now() + 60_000 })),
      onPush: () => () => {},
      onOpen: () => () => {},
    } as never);

  it("takes a device token for this window's own host, and offers only the code for another host, which never takes a token from afar", async () => {
    host(registry.primaryEnvironmentId);
    const own = render(<SignInDialog environmentId={registry.primaryEnvironmentId} state={{ state: "signed-out" } as never} onClose={() => {}} />);
    await act(() => Promise.resolve());
    expect(screen.queryByPlaceholderText("lo_…")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeNull();
    own.unmount();
    host("env_box");
    render(<SignInDialog environmentId="env_box" state={{ state: "signed-out" } as never} onClose={() => {}} />);
    await act(() => Promise.resolve());
    expect(screen.queryByPlaceholderText("lo_…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByText("ABCD-1234")).not.toBeNull();
  });

  it("offers no token at /ui, where this window's own link is a key's and the token is local-only", async () => {
    testKey.current = OWNER_KEY;
    host(registry.primaryEnvironmentId);
    render(<SignInDialog environmentId={registry.primaryEnvironmentId} state={{ state: "signed-out" } as never} onClose={() => {}} />);
    await act(() => Promise.resolve());
    expect(screen.queryByPlaceholderText("lo_…")).toBeNull();
    expect(screen.queryByText("ABCD-1234")).not.toBeNull();
  });
});
