import { describe, expect, it, vi } from "vitest";

const asked = vi.hoisted(() => [] as string[]);
vi.mock("../../lib/connection", () => {
  const link = {
    request: async (method: string) => {
      asked.push(method);
      if (method === "workspace.create") return { id: "ws", name: "Purdue Esports", kind: "work", sector: "purdue" };
      if (method === "work.workspace.get") return { mayUseDesktop: [], windowsVm: false };
      if (method === "remote.status") return { environmentId: "env_pc" };
      return {};
    },
  };
  return {
    LOCAL_ENVIRONMENT_ID: "local",
    registry: {
      has: (id: string) => id === "local" || id === "env_box",
      linkOf: () => link,
      link: () => link,
      environments: () => [{ id: "local", name: "Purdue laptop", platform: "win32" }],
    },
  };
});
vi.mock("../../lib/tcserver/workspaces", () => ({ workspaceStore: { refresh: async () => undefined } }));
vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));
const { GIVEN_KEY, resetTestKey, testKey } = await import("../../lib/linkMay.testkit");
const { createWorkWorkspace, desktopRows, hostIdOfLink, linkIdOfHost } = await import("./actions");

describe("a new Work workspace", () => {
  it("lets it use his desktops where this window's key may, and never asks the write a given computer's key cannot make", async () => {
    await createWorkWorkspace("env_box", { sector: "purdue", name: "Purdue Esports" });
    expect(asked).toContain("work.workspace.set");
    asked.length = 0;
    testKey.current = GIVEN_KEY;
    await createWorkWorkspace("env_box", { sector: "purdue", name: "Purdue Esports" });
    expect(asked).toEqual(["workspace.create"]);
    resetTestKey();
  });
});

describe("host ids and the window's links", () => {
  it("names this machine local in the window and by its id to every host", () => {
    expect(hostIdOfLink("local", "env_mac")).toBe("env_mac");
    expect(hostIdOfLink("env_box", "env_mac")).toBe("env_box");
    expect(linkIdOfHost("env_mac", "env_mac")).toBe("local");
    expect(linkIdOfHost("env_box", "env_mac")).toBe("env_box");
    expect(linkIdOfHost("env_pc", "env_mac")).toBeNull();
  });
});

describe("the Computer use rows", () => {
  const mac = [{ id: "local", name: "This Mac", platform: "darwin" }, { id: "env_box", name: "The box", platform: "linux" }];
  const known = [
    { id: "env_mac", name: "Mac", platform: "darwin" as const },
    { id: "env_pc", name: "PURDUE-LT", platform: "win32" as const },
  ];
  it("adds each desktop the workspace's host knows that the window has none for, and this machine once", () => {
    expect(desktopRows(mac, known, "env_mac")).toEqual([
      { link: "local", host: "env_mac", name: "This Mac" },
      { link: "env_pc", host: "env_pc", name: "PURDUE-LT" },
    ]);
  });
  it("draws the window's own until this machine's id is known", () => {
    expect(desktopRows(mac, known, null)).toEqual([{ link: "local", host: "local", name: "This Mac" }]);
  });
});
