// @vitest-environment jsdom
/** Settings → Work: each host's LifeOS sign-in lives on Connections now, and a workspace page's failed read offers Retry. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { registry } from "../../lib/connection";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { resetLifeos, setLifeosSession, setLifeosStatus } from "./lifeos";

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
const { SignInDialog } = await import("./settings");

afterEach(() => {
  cleanup();
  resetLifeos();
  workSwitch.reset();
  vi.restoreAllMocks();
  resetTestKey();
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
    // The code's own line from a sample, at the code's 24px leading.
    const bone = document.querySelector<HTMLElement>("[data-region][data-bones] [skullet-loading] [data-code-bone]")!;
    expect(bone.className).toContain("leading-6");
    await act(async () => land({ code: "ABCD-1234", expiresAt: Date.now() + 60_000 }));
    expect(document.querySelector("[data-region][data-bones=held], [data-region][data-bones=shown]")).toBeNull();
    expect(screen.getAllByText("ABCD-1234").some((el) => !el.closest("[skullet-loading]"))).toBe(true);
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
    expect(document.querySelector("[data-region][aria-busy]")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("The box did not answer");
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());
    expect(request).toHaveBeenCalledTimes(2);
    expect(linkOf.mock.calls.every(([id]) => id === "env_box")).toBe(true);
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /** Council round 12 (Sol, Settings 2): Retry cleared the failed row for a bone, with no sign the press was heard. */
  it("keeps the failed code row with Retry spinning in place until the new code lands; New code the same", async () => {
    vi.spyOn(registry, "environment").mockReturnValue({ id: "env_box", name: "The box" } as never);
    const answers: ((v: unknown) => void)[] = [];
    const request = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(Object.assign(new Error("No answer in 15 s"), { name: "TimeoutError" })))
      .mockImplementation(() => new Promise((r) => answers.push(r)));
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request, onPush: () => () => {}, onOpen: () => () => {} } as never);
    render(<SignInDialog environmentId="env_box" state={{ state: "signed-out" } as never} onClose={() => {}} />);
    await act(() => Promise.resolve());
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());
    // The ask is out: the row stays, its Retry spinning and held, and no bone takes its place.
    expect(screen.getByRole("alert").textContent).toBe("The box did not answer");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(retry.querySelector("[data-busy]")).toBeTruthy();
    expect(document.querySelector("[data-region][aria-busy]")).toBeNull();
    await act(async () => answers.shift()!({ code: "ABCD-1234", expiresAt: Date.now() - 1_000 }));
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    // Past its life: New code spins where it stands, the old code kept, until the new one lands.
    await act(async () => screen.getByRole("button", { name: "New code" }).click());
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New code" }).querySelector("[data-busy]")).toBeTruthy();
    await act(async () => answers.shift()!({ code: "WXYZ-5678", expiresAt: Date.now() + 60_000 }));
    expect(screen.getByText("WXYZ-5678")).toBeTruthy();
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

  /** WORK's request (POLISH-work item 51): a New code ask that failed after the old code ran out left the dead code. */
  it("clears a code past its life when the ask for a new one fails, and says why in its place with Retry", async () => {
    const request = vi.fn(() => Promise.reject(new Error("forbidden")));
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request, onPush: () => () => {}, onOpen: () => () => {} } as never);
    render(<SignInDialog environmentId="env_box" state={{ state: "pairing", code: "ABCD-1234", expiresAt: Date.now() - 1_000 } as never} onClose={() => {}} />);
    await act(() => Promise.resolve());
    await act(async () => screen.getByRole("button", { name: "New code" }).click());
    expect(screen.queryByText("ABCD-1234")).toBeNull();
    expect(screen.queryByRole("button", { name: "New code" })).toBeNull();
    expect(document.querySelector("[data-code-failed]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
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
