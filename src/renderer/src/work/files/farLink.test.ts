import { describe, expect, it, vi } from "vitest";

const box = { request: vi.fn(async (..._: unknown[]) => ({ ok: true })), onPush: vi.fn(() => () => {}), onOpen: vi.fn(() => () => {}) };
vi.mock("../../lib/connection", () => ({
  registry: {
    has: (id: string) => id === "env_box",
    linkOf: (id: string) => {
      if (id === "env_box") return box;
      throw new Error(`unknown environment: ${id}`);
    },
  },
}));

const { farName, filesLink, keepFarName, reachThrough } = await import("./farLink");
const { unreachable } = await import("./store");

describe("a desktop the window has no link to", () => {
  it("is asked for its listing through the workspace's host", async () => {
    reachThrough("env_pc", "env_box", "w1");
    await filesLink("env_pc").request("work.files.list", { workspaceId: "w1", at: { at: "place", id: "x" } }, { timeoutMs: 5 });
    expect(box.request).toHaveBeenCalledWith("work.files.across", { workspaceId: "w1", host: "env_pc", method: "work.files.list", params: { at: { at: "place", id: "x" } } }, { timeoutMs: 5 });
  });

  it("is asked nothing else, and hears no pushes", async () => {
    await expect(filesLink("env_pc").request("work.files.preview", { workspaceId: "w1" })).rejects.toThrow("reached through another host");
    expect(typeof filesLink("env_pc").onPush(() => {})).toBe("function");
  });

  it("leaves a linked host and an unknown one as the registry has them", () => {
    expect(filesLink("env_box")).toBe(box);
    expect(() => filesLink("env_other")).toThrow("unknown environment");
  });

  it("keeps the name its host last said, for a line while it is away; the box's words for an away desktop read as away", () => {
    expect(farName("env_pc2")).toBeUndefined();
    keepFarName("env_pc2", "Purdue laptop");
    keepFarName("env_pc2", undefined);
    expect(farName("env_pc2")).toBe("Purdue laptop");
    expect(unreachable(new Error("Purdue laptop is not reachable now."))).toBe(true);
  });
});
