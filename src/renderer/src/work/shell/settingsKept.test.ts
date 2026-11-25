/**
 * A workspace's Work settings are asked once and kept (shell/actions.ts `workspaceSettings`): joined while out,
 * kept until this window sets them or the host's link comes back, and read fresh where a screen writes from them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ calls: [] as string[], opens: [] as (() => void)[], settings: { mayUseDesktop: ["mac"], windowsVm: false } }));
vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({
    environmentId: id,
    request: async (method: string, params: { patch?: Record<string, unknown> }) => {
      net.calls.push(method);
      if (method === "work.workspace.set") net.settings = { ...net.settings, ...params.patch };
      return { ...net.settings };
    },
    onOpen: (fn: () => void) => (net.opens.push(fn), () => undefined),
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: () => true, environments: () => [] } };
});

const { forgetWorkspaceSettings, setWorkspaceSettings, workspaceSettings, workspaceSettingsKept } = await import("./actions");
const ws = { id: "w1", environmentId: "box" };

beforeEach(() => {
  forgetWorkspaceSettings();
  net.calls = [];
  net.settings = { mayUseDesktop: ["mac"], windowsVm: false };
});

describe("a workspace's settings, kept", () => {
  it("asks once for asks at once and after, and again only fresh, after this window sets them, or once its link comes back", async () => {
    const [a, b] = await Promise.all([workspaceSettings(ws), workspaceSettings(ws)]);
    await workspaceSettings(ws);
    expect(net.calls).toEqual(["work.workspace.get"]);
    expect(b).toEqual(a);
    // A screen that writes from what it read asks now.
    await workspaceSettings(ws, { fresh: true });
    expect(net.calls).toEqual(["work.workspace.get", "work.workspace.get"]);
    // Set here: its answer is what is kept.
    await setWorkspaceSettings(ws, { windowsVm: true });
    expect(await workspaceSettings(ws)).toMatchObject({ windowsVm: true });
    expect(net.calls).toEqual(["work.workspace.get", "work.workspace.get", "work.workspace.set"]);
    // The link came back: another window may have set them meanwhile.
    for (const open of net.opens) open();
    await workspaceSettings(ws);
    expect(net.calls.at(-1)).toBe("work.workspace.get");
    expect(net.calls).toHaveLength(4);
  });

  /** Sol round 1, S7: a workspace's settings past their five minutes are not kept on, a removed workspace's included. */
  it("lets go of what has outlived its five minutes when another workspace is asked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await workspaceSettings({ id: "gone", environmentId: "box" });
      vi.setSystemTime(Date.now() + 6 * 60_000);
      await workspaceSettings(ws);
      expect(workspaceSettingsKept()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
