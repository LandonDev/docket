// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerPush } from "./tcserver/types";
import type { Link } from "./connection/link";
import { openWorkView, setLifeosProjects, setWorkHome, setWorkOn, workHome, workSwitch } from "./workSwitch";

/** A host's link: answers `work.get` with `enabled`, and hands its push and open listeners to the test. */
function fakeLink(environmentId: string, enabled: boolean | "refuse") {
  const pushes = new Set<(push: ServerPush) => void>();
  const opens = new Set<() => void>();
  const link = {
    environmentId,
    connected: true,
    request: vi.fn(async (method: string) => {
      if (method !== "work.get") throw new Error(method);
      if (enabled === "refuse") throw new Error("unknown method: work.get");
      return { enabled };
    }),
    onPush: (fn: (push: ServerPush) => void) => (pushes.add(fn), () => void pushes.delete(fn)),
    onOpen: (fn: () => void) => (opens.add(fn), () => void opens.delete(fn)),
  } as unknown as Link;
  return { link, push: (push: unknown) => pushes.forEach((fn) => fn(push as ServerPush)), open: () => opens.forEach((fn) => fn()) };
}

function registryOf(links: Link[]) {
  let listener: ((link: Link, event: "added" | "removed") => void) | null = null;
  return {
    onLink(fn: (link: Link, event: "added" | "removed") => void) {
      listener = fn;
      for (const link of links) fn(link, "added");
      return () => {};
    },
    remove: (link: Link) => listener?.(link, "removed"),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  workSwitch.reset();
  localStorage.clear();
});

describe("the Work switch as the window knows it", () => {
  it("is off until a host says otherwise, and on while any host is on", async () => {
    const mac = fakeLink("local", false);
    const box = fakeLink("env_box", true);
    workSwitch.connect(registryOf([mac.link, box.link]));
    expect(workSwitch.anyOn()).toBe(false);
    await flush();
    expect([...workSwitch.hosts()]).toEqual(["env_box"]);
    expect(workSwitch.anyOn()).toBe(true);
  });

  it("follows the work push, and a host from before Work reads as off", async () => {
    const old = fakeLink("env_old", "refuse");
    const box = fakeLink("env_box", false);
    workSwitch.connect(registryOf([old.link, box.link]));
    await flush();
    expect(workSwitch.anyOn()).toBe(false);
    box.push({ push: "work", settings: { enabled: true } });
    expect([...workSwitch.hosts()]).toEqual(["env_box"]);
    box.push({ push: "work", settings: { enabled: false } });
    expect(workSwitch.anyOn()).toBe(false);
  });

  it("asks again when a socket opens, and a host that leaves takes its switch with it", async () => {
    const box = fakeLink("env_box", true);
    const reg = registryOf([box.link]);
    workSwitch.connect(reg);
    await flush();
    box.open();
    await flush();
    expect(box.link.request).toHaveBeenCalledTimes(2);
    reg.remove(box.link);
    expect(workSwitch.anyOn()).toBe(false);
  });

  it("keeps the last answer when a request is cut, and drops a remembered host that never comes back", async () => {
    vi.useFakeTimers();
    try {
      const box = fakeLink("env_box", true);
      workSwitch.connect(registryOf([box.link]));
      await vi.advanceTimersByTimeAsync(0);
      setWorkOn("env_gone", true);
      (box.link.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("socket closed"));
      box.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(workSwitch.hosts().has("env_box")).toBe(true);
      await vi.advanceTimersByTimeAsync(15_000);
      expect([...workSwitch.hosts()]).toEqual(["env_box"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends new Work things to a host with Work on: the one picked, else the box, else this machine", () => {
    const envs = [
      { id: "local", platform: "darwin" },
      { id: "env_box", platform: "linux" },
    ];
    expect(workHome(envs, "local")).toBeNull();
    setWorkOn("local", true);
    expect(workHome(envs, "local")).toBe("local");
    setWorkOn("env_box", true);
    expect(workHome(envs, "local")).toBe("env_box");
    setWorkHome("local");
    expect(workHome(envs, "local")).toBe("local");
    // A pick whose host has Work off is passed over.
    setWorkOn("local", false);
    expect(workHome(envs, "local")).toBe("env_box");
  });

  it("remembers the hosts that were on, so a launch paints the rail it had", () => {
    setWorkOn("env_box", true);
    expect(JSON.parse(localStorage.getItem("work.on.v1") ?? "[]")).toEqual(["env_box"]);
    setWorkOn("env_box", false);
    expect(JSON.parse(localStorage.getItem("work.on.v1") ?? "[]")).toEqual([]);
  });

  it("tells its listeners only of a real change", () => {
    const heard = vi.fn();
    const off = workSwitch.subscribe(heard);
    setWorkOn("env_box", true);
    setWorkOn("env_box", true);
    setLifeosProjects("w1", [{ id: "p1", name: "Spring LAN" }]);
    setLifeosProjects("w1", [{ id: "p1", name: "Spring LAN" }]);
    openWorkView({ workspaceId: "w1", view: "mail" });
    openWorkView({ workspaceId: "w1", view: "mail" });
    expect(heard).toHaveBeenCalledTimes(3);
    off();
  });
});
