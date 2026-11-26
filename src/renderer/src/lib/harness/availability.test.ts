import { describe, expect, it, vi } from "vitest";

vi.mock("../connection", () => ({
  registry: {
    primaryEnvironmentId: "local",
    environment: (id: string) => (id === "box" ? { name: "The box" } : id === "local" ? { name: "This Mac" } : undefined),
  },
}));
vi.mock("./registry", () => ({ isLiveHarness: (id: string) => id !== "cursor" }));
vi.mock("../tcserver/catalog", () => ({ availabilityFromDoctor: () => ({}), probeDoctor: () => Promise.reject(new Error("unused")) }));

import { harnessUnavailableHint } from "./availability";

describe("harnessUnavailableHint", () => {
  it("names the host in a person's words: no program name, no install command, no plan talk", () => {
    expect(harnessUnavailableHint("claude", "box")).toBe("Not installed on the box");
    expect(harnessUnavailableHint("grok")).toBe("Not installed on this Mac");
    expect(harnessUnavailableHint("codex", "gone")).toBe("Not installed");
    // A provider this build cannot run names the computer too, never "this host".
    expect(harnessUnavailableHint("cursor", "box")).toBe("Not available on the box");
    expect(harnessUnavailableHint("cursor")).toBe("Not available on this Mac");
    expect(harnessUnavailableHint("cursor", "gone")).toBe("Not available");
    for (const id of ["claude", "grok", "muse", "cursor"] as const) {
      const words = harnessUnavailableHint(id, "box");
      expect(words).not.toMatch(/CLI|curl|npm|`|milestone|restart|host|\.$/);
    }
  });
});
