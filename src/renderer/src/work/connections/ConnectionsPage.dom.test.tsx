// @vitest-environment jsdom
/** Settings → Connections: checks each linked host when it opens, says an unlinked host is offline, and a fix's press runs it on the row's host, then checks that host again. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthReport } from "@shared/work/health";
import { registry } from "../../lib/connection";

vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  useEnvironments: () => [
    { id: "box", name: "the box", platform: "linux" },
    { id: "mac", name: "Mac", platform: "darwin" },
  ],
  useEnvironmentStatuses: () => new Map([["box", { transport: "open" }], ["mac", { transport: "offline" }]]),
}));
vi.mock("../../lib/workSwitch", async (original) => ({ ...(await original<object>()), useWorkHosts: () => new Set(["box", "mac"]) }));

const { ConnectionsPage } = await import("./ConnectionsPage");

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Connections", () => {
  it("checks the linked host, says the other is offline, and runs a fix on the row's host", async () => {
    let tools: "broken" | "working" = "broken";
    const report = (): HealthReport => ({
      host: "env_box",
      at: 1,
      rows: [
        tools === "broken"
          ? { id: "formats.tools", pillar: "formats", group: "Tools", title: "Conversion tools", state: "broken", line: "LibreOffice did not install", fix: { kind: "run", label: "Install", method: "work.formats.install" } }
          : { id: "formats.tools", pillar: "formats", group: "Tools", title: "Conversion tools", state: "working", line: "LibreOffice 26.8" },
      ],
    });
    const request = vi.fn(async (method: string) => {
      if (method === "work.formats.install") tools = "working";
      return method === "work.health" ? report() : null;
    });
    const linkOf = vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(linkOf).not.toHaveBeenCalledWith("mac");
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("Broken")).toBeTruthy();
    expect(screen.getByText("LibreOffice did not install")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await settle();
    await settle();
    expect(request.mock.calls.map((c) => c[0])).toEqual(["work.health", "work.formats.install", "work.health"]);
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("says a host that refuses did not answer, with Retry", async () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({ request: vi.fn(async () => Promise.reject(new Error("Work is off on this host"))) } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(screen.getByText("Did not answer")).toBeTruthy();
    expect(screen.getByText("Work is off on this host")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
