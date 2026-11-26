import { afterEach, describe, expect, it, vi } from "vitest";
import type { AwaySnapshot } from "@server/shared/contract-away";
import { attachAwayLink, awayKinds, awayStore, onAwayPush, resetAwayForTest, setAway } from "./away";
import { registry } from "./connection/registry";
import * as toaster from "../components/ui/toaster";
import type { ServerPush } from "./tcserver/types";
import { markUsable } from "./tcserver/openPhase";

// the window is usable: a host's open runs its second phase, where Away's read is (tcserver/openPhase.ts)
markUsable();

/** A link that answers `away.get` with `snapshot` and lets the test push. */
function fakeLink(environmentId: string, snapshot: AwaySnapshot) {
  let push: (p: ServerPush) => void = () => {};
  let open: () => void = () => {};
  const link = {
    environmentId,
    connected: false,
    request: vi.fn(async () => snapshot),
    onPush: (l: (p: ServerPush) => void) => ((push = l), () => {}),
    onOpen: (l: () => void) => ((open = l), () => {}),
  };
  // a socket that opened is connected, as an EnvLink's is
  return { link: link as never, push: (p: AwaySnapshot) => push({ push: "away", ...p } as ServerPush), open: () => ((link.connected = true), open()) };
}

const snap = (enabled: boolean, at: number, threads: { sessionId: string; count: number }[] = []): AwaySnapshot => ({
  state: { enabled, at, by: "env_mac" },
  decided: { since: at, threads },
});

afterEach(() => resetAwayForTest());

describe("the away store", () => {
  it("reads a host's state at open, and hears only its live pushes as pushes", async () => {
    const heard = vi.fn();
    onAwayPush(heard);
    const box = fakeLink("env_box", snap(true, 10));
    attachAwayLink(box.link);
    box.open();
    await vi.waitFor(() => expect(awayStore.getState().hosts.env_box?.state.enabled).toBe(true));
    expect(heard).not.toHaveBeenCalled();
    box.push(snap(false, 20, [{ sessionId: "a", count: 2 }]));
    expect(heard).toHaveBeenCalledWith("env_box", snap(true, 10), snap(false, 20, [{ sessionId: "a", count: 2 }]));
    expect(awayStore.getState().hosts.env_box?.decided.threads).toEqual([{ sessionId: "a", count: 2 }]);
  });

  it("shows this machine's flip until the host's word is as new", () => {
    const local = fakeLink(registry.primaryEnvironmentId, snap(false, 0));
    attachAwayLink(local.link);
    awayStore.setState({ pending: { enabled: true, at: 50, by: "" } });
    expect(awayKinds()).toEqual({ code: true, work: true });
    local.push(snap(false, 40));
    expect(awayStore.getState().pending).not.toBeNull();
    local.push(snap(true, 60));
    expect(awayStore.getState().pending).toBeNull();
    expect(awayKinds()).toEqual({ code: true, work: true });
  });

  it("reads another host's state apart from this machine's", () => {
    const box = fakeLink("env_box", snap(false, 0));
    attachAwayLink(box.link);
    box.push(snap(true, 5));
    expect(awayKinds()).toEqual({ code: false, work: false });
  });

  it("reads an older host's `enabled` alone as both kinds", () => {
    const local = fakeLink(registry.primaryEnvironmentId, snap(false, 0));
    attachAwayLink(local.link);
    local.push(snap(true, 5));
    expect(awayKinds()).toEqual({ code: true, work: true });
  });

  it("sets one kind and names only it, with `enabled` for an older host", async () => {
    let held = { code: false, work: true };
    const request = vi.fn(async (_m: string, p: { code?: boolean; work?: boolean }) => {
      held = { code: p.code ?? held.code, work: p.work ?? held.work };
      return { state: { enabled: held.code && held.work, ...held, at: 9, by: "env_mac" } };
    });
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    awayStore.setState({ hosts: { [registry.primaryEnvironmentId]: { state: { enabled: false, code: false, work: true, at: 1, by: "env_mac" }, decided: { since: 1, threads: [] } } } });
    const flip = setAway({ code: true });
    expect(awayKinds()).toEqual({ code: true, work: true });
    await flip;
    expect(request).toHaveBeenCalledWith("away.set", { enabled: true, code: true });
    await setAway({ work: false });
    expect(request).toHaveBeenLastCalledWith("away.set", { enabled: false, work: false });
    vi.restoreAllMocks();
  });

  it("answers whether the host saved the flip, and keeps the toast for a quiet caller", async () => {
    const error = vi.fn();
    vi.spyOn(toaster, "loadToast").mockResolvedValue({ error } as never);
    const request = vi.fn(async () => ({ state: { enabled: true, code: true, work: true, at: 9, by: "env_mac" } }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    expect(await setAway({ code: true })).toBe(true);
    request.mockRejectedValue(new Error("refused"));
    expect(await setAway({ work: false }, { quiet: true })).toBe(false);
    expect(awayStore.getState().pending).toBeNull();
    await Promise.resolve();
    expect(error).not.toHaveBeenCalled();
    expect(await setAway({ work: false })).toBe(false);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Couldn't change Away"));
    vi.restoreAllMocks();
  });
});
