import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/connection", () => ({ LOCAL_ENVIRONMENT_ID: "local", registry: { has: (id: string) => id === "local" || id === "env_box" } }));
const { desktopRows, hostIdOfLink, linkIdOfHost } = await import("./actions");

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
