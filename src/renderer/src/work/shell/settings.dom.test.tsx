// @vitest-environment jsdom
/** Settings → Work: each host's LifeOS sign-in lives on Connections now, and a workspace page's failed read offers Retry. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { resetLifeos, setLifeosStatus } from "./lifeos";

// A link's transport by hand where a test sets one; else the real hook.
const transport = vi.hoisted(() => ({ now: null as string | null }));
vi.mock("../../lib/connection", async (original) => {
  const real = await original<typeof import("../../lib/connection")>();
  return {
    ...real,
    useEnvironments: () => [{ id: "env_box", name: "The box", platform: "linux" }],
    useEnvironmentStatus: (id: string) => {
      const status = real.useEnvironmentStatus(id);
      return transport.now ? { ...status, transport: transport.now } : status;
    },
  };
});
// The rows under LifeOS are what this test reads; the sections after it stand still.
vi.mock("../office/AddinRow", () => ({ AddinRow: () => null }));
vi.mock("../guests/GuestLinksSection", () => ({ GuestLinksSection: () => null }));
vi.mock("../rules/HouseRules", () => ({ HouseRules: () => null }));
vi.mock("../../chrome/ThreadDefaultsDialog", async (original) => ({ ...(await original<object>()), ThreadDefaultsEditor: () => <div data-defaults /> }));
vi.mock("../../lib/tcserver/workspaces", async (original) => ({
  ...(await original<object>()),
  useWorkspaces: () => [
    { id: "ws", name: "Purdue Esports", environmentId: "env_box", sector: "purdue", kind: "work", path: "/w" },
    { id: "code", name: "temp-code", environmentId: "env_box", sector: "purdue", kind: "code", path: "/c" },
    { id: "bare", name: "site", environmentId: "env_box", sector: null, kind: "code", path: "/b" },
  ],
}));
const reads = vi.hoisted(() => ({ fail: true, asked: 0, error: "The host did not answer" }));
vi.mock("./actions", async (original) => ({
  ...(await original<object>()),
  workspaceSettings: async () => {
    reads.asked++;
    if (reads.fail) throw new Error(reads.error);
    return { mayUseDesktop: [], model: null, reasoning: null, voice: false };
  },
  // The box knows the PC paired to it alone; this window (the Mac's) has no link to it.
  hostDesktops: async () => [{ id: "env_pc", name: "PURDUE-LT", platform: "win32" }],
  localHostId: async () => "env_mac",
}));

const requestSettings = vi.hoisted(() => vi.fn());
vi.mock("../../lib/monaco/debugTab", async (original) => ({ ...(await original<object>()), requestSettings }));
vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));
const { GIVEN_KEY, OWNER_KEY, resetTestKey, testKey } = await import("../../lib/linkMay.testkit");
const { CodeWorkspaceSector, SignInDialog, WorkSettingsBody, WorkWorkspacePage } = await import("./settings");

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
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
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

  it("says a read that failed in his words and names the computer, never the link's own text", async () => {
    reads.fail = true;
    reads.error = "work.workspace.get failed at /srv/agents/work/x.json";
    vi.spyOn(registry, "environment").mockReturnValue({ id: "env_box", name: "The box", routes: [], credentialRef: "env_box" } as never);
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(async () => ({ lifeos: { state: "signed-out" }, keys: [] })), onPush: () => () => {}, onOpen: () => () => {} } as never);
    render(<WorkWorkspacePage workspaceId="ws" />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.getByText("The box did not send this workspace's settings.")).toBeTruthy();
    expect(screen.queryByText(/srv\/agents/)).toBeNull();
    reads.error = "The host did not answer";
  });

  /** Council round 10 (Opus Settings 3): the Sector row said the sign-out a second time, above Waiting on's line. */
  it("lets the Sector row say only its sector while the host's LifeOS is down, and its key line once it is connected", async () => {
    reads.fail = false;
    vi.spyOn(registry, "environment").mockReturnValue({ id: "env_box", name: "The box", routes: [], credentialRef: "env_box" } as never);
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(async () => new Promise(() => {})), onPush: () => () => {}, onOpen: () => () => {} } as never);
    setLifeosStatus("env_box", { lifeos: { state: "signed-out" }, keys: [{ workspaceId: "ws", sectors: ["purdue"], state: "waiting" }] });
    render(<WorkWorkspacePage workspaceId="ws" />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.queryByText(/Its key is made once/)).toBeNull();
    act(() => setLifeosStatus("env_box", { lifeos: { state: "connected", ownerId: "o", since: 1 }, keys: [{ workspaceId: "ws", sectors: ["purdue"], state: "failed", error: "Its key could not be made" }] }));
    expect(screen.getByText("Its key could not be made")).toBeTruthy();
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
    expect(screen.getAllByText("Computer use is changed from a computer that manages the box")).toHaveLength(1);
    expect(request.mock.calls.map((c: unknown[]) => c[0]).filter((m) => m === "work.workspace.set" || m === "work.mail.waiting")).toEqual([]);
  });
});

describe("a code workspace's LifeOS sector", () => {
  const box = () => {
    setWorkOn("env_box", true);
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(async () => ({ lifeos: { state: "signed-out" }, keys: [] })), onPush: () => () => {}, onOpen: () => () => {} } as never);
  };

  it("offers the sector's select to a key that may link it", async () => {
    box();
    render(<CodeWorkspaceSector workspaceId="code" />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.getByRole("combobox", { name: "LifeOS sector" })).toBeTruthy();
  });

  it("shows a given computer the sector and who changes it, with no select the host would refuse", async () => {
    // work.lifeos.link needs admin (W-37).
    testKey.current = GIVEN_KEY;
    box();
    render(<CodeWorkspaceSector workspaceId="code" />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.queryByRole("combobox", { name: "LifeOS sector" })).toBeNull();
    expect(screen.getByText("Purdue")).toBeTruthy();
    expect(screen.getByText("Changed from a computer that manages the box")).toBeTruthy();
  });
});

describe("a code workspace with no sector, LifeOS signed out", () => {
  it("says Not signed in to LifeOS with Sign in, which opens the sign-in dialog in place", async () => {
    setWorkOn("env_box", true);
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(async () => ({ lifeos: { state: "signed-out" }, keys: [] })), onPush: () => () => {}, onOpen: () => () => {} } as never);
    setLifeosStatus("env_box", { lifeos: { state: "signed-out" }, keys: [] });
    render(<CodeWorkspaceSector workspaceId="bare" />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.getByText(/^Not signed in to LifeOS/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy(), { timeout: 5000 });
    expect(requestSettings).not.toHaveBeenCalledWith("connections");
  });
});

describe("a code workspace with no sector, LifeOS not signed out (Sol round 2 P1)", () => {
  const status = (answer: () => Promise<unknown>) => {
    // The link first: turning Work on wakes every store that watches it (the outbox's among them), and each asks the host.
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(answer), onPush: () => () => {}, onOpen: () => () => {} } as never);
    setWorkOn("env_box", true);
  };

  it("draws the sector row's bones while the host's status is on its way, never the signed-out line", async () => {
    status(() => new Promise(() => {}));
    transport.now = "open";
    try {
      render(<CodeWorkspaceSector workspaceId="bare" />);
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
      expect(screen.queryByText(/^Not signed in to LifeOS/)).toBeNull();
      expect(screen.getByLabelText("Loading")).toBeTruthy();
    } finally {
      transport.now = null;
    }
  });

  /** Sol round 3 P1: a first status ask that timed out on an open link stops the bones and names the host with Retry. */
  it("names the host whose first status ask timed out, and Retry asks again until the sector row shows", async () => {
    let reply: () => Promise<unknown> = () => Promise.reject(Object.assign(new Error("no answer in 15 s"), { name: "TimeoutError" }));
    status(() => reply());
    vi.spyOn(registry, "environment").mockReturnValue({ id: "env_box", name: "the box" } as never);
    transport.now = "open";
    try {
      render(<CodeWorkspaceSector workspaceId="bare" />);
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
      expect(screen.queryByLabelText("Loading")).toBeNull();
      expect(screen.getByRole("alert").textContent).toBe("The box did not answer");
      reply = async () => ({ lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("Sector")).toBeTruthy();
      // The session the connected status opens lands before the reset, so nothing of it reaches the next test.
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    } finally {
      transport.now = null;
    }
  });

  it("says LifeOS did not answer with Retry when the host cannot reach it", async () => {
    status(async () => ({ lifeos: { state: "unreachable", since: 1, error: "x" }, keys: [] }));
    setLifeosStatus("env_box", { lifeos: { state: "unreachable", since: 1, error: "x" }, keys: [] });
    render(<CodeWorkspaceSector workspaceId="bare" />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.queryByText(/^Not signed in to LifeOS/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/^LifeOS did not answer/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
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

  it("holds the code's 24px line with a bone while it is asked for, so nothing moves when it lands", async () => {
    let land!: (v: unknown) => void;
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(() => new Promise((r) => (land = r))), onPush: () => () => {}, onOpen: () => () => {} } as never);
    render(<SignInDialog environmentId="env_box" state={{ state: "signed-out" } as never} onClose={() => {}} />);
    await act(() => Promise.resolve());
    const bone = screen.getByRole("status", { name: "Asking for a code" });
    expect(bone.className).toContain("h-6");
    expect(bone.querySelector("[data-slot=skeleton]")).not.toBeNull();
    await act(async () => land({ code: "ABCD-1234", expiresAt: Date.now() + 60_000 }));
    expect(screen.queryByRole("status", { name: "Asking for a code" })).toBeNull();
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
  });

  /** Council round 8 (Sol, Settings 3): a code ask that timed out said its error under a bone still "Asking for a code". */
  it("says a code ask the host did not answer in the code's place, never under bones, and Retry asks the same computer again", async () => {
    vi.spyOn(registry, "environment").mockReturnValue({ id: "env_box", name: "The box" } as never);
    const request = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(Object.assign(new Error("No answer in 15 s"), { name: "TimeoutError" })))
      .mockImplementation(() => Promise.resolve({ code: "ABCD-1234", expiresAt: Date.now() + 60_000 }));
    const linkOf = vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request, onPush: () => () => {}, onOpen: () => () => {} } as never);
    render(<SignInDialog environmentId="env_box" state={{ state: "signed-out" } as never} onClose={() => {}} />);
    await act(() => Promise.resolve());
    expect(screen.queryByRole("status", { name: "Asking for a code" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("The box did not answer");
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());
    expect(request).toHaveBeenCalledTimes(2);
    expect(linkOf.mock.calls.every(([id]) => id === "env_box")).toBe(true);
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /** Council round 9 (Opus, Settings 1): a code past its life said Expired, and nothing in the dialog asked for a new one. */
  it("puts New code where the timer stood once the code expires, which asks the same computer for a new one", async () => {
    const request = vi.fn(() => Promise.resolve({ code: "WXYZ-5678", expiresAt: Date.now() + 60_000 }));
    const linkOf = vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request, onPush: () => () => {}, onOpen: () => () => {} } as never);
    render(<SignInDialog environmentId="env_box" state={{ state: "pairing", code: "ABCD-1234", expiresAt: Date.now() - 1_000 } as never} onClose={() => {}} />);
    await act(() => Promise.resolve());
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.queryByText("Expired")).toBeNull();
    expect(request).not.toHaveBeenCalled();
    await act(async () => screen.getByRole("button", { name: "New code" }).click());
    expect(request).toHaveBeenCalledWith("work.lifeos.pairStart", {});
    expect(linkOf.mock.calls.every(([id]) => id === "env_box")).toBe(true);
    expect(screen.getByText("WXYZ-5678")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New code" })).toBeNull();
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
