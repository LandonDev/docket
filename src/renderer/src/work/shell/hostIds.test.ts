import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/connection", () => ({ LOCAL_ENVIRONMENT_ID: "local", registry: { has: (id: string) => id === "local" || id === "env_box" } }));
const { hostIdOfLink, linkIdOfHost } = await import("./actions");

describe("host ids and the window's links", () => {
  it("names this machine local in the window and by its id to every host", () => {
    expect(hostIdOfLink("local", "env_mac")).toBe("env_mac");
    expect(hostIdOfLink("env_box", "env_mac")).toBe("env_box");
    expect(linkIdOfHost("env_mac", "env_mac")).toBe("local");
    expect(linkIdOfHost("env_box", "env_mac")).toBe("env_box");
    expect(linkIdOfHost("env_pc", "env_mac")).toBeNull();
  });
});
