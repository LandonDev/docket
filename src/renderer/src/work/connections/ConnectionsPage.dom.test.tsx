// @vitest-environment jsdom
/** Settings → Connections: checks each linked host when it opens, says an unlinked host is offline, and a fix's press runs it on the row's host, then checks that host again. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthReport } from "@shared/work/health";
import { registry } from "../../lib/connection";

const links = vi.hoisted(() => ({ box: "open" as string }));
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  useEnvironments: () => [
    { id: "box", name: "the box", platform: "linux" },
    { id: "mac", name: "Mac", platform: "darwin" },
  ],
  useEnvironmentStatuses: () => new Map([["box", { transport: links.box }], ["mac", { transport: "offline" }]]),
}));
vi.mock("../../lib/workSwitch", async (original) => ({ ...(await original<object>()), useWorkHosts: () => new Set(["box", "mac"]) }));

const signInOnVm = vi.hoisted(() => vi.fn(async (_env: string) => ({ computer: "vm:windows", account: null, line: "" })));
vi.mock("../winvm/signIn", () => ({ signInOnVm }));

const { ConnectionsPage } = await import("./ConnectionsPage");

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

afterEach(() => {
  links.box = "open";
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
          ? { id: "lifeos.signin", pillar: "lifeos", group: "LifeOS", title: "LifeOS", state: "broken", line: "Still connecting", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }
          : { id: "lifeos.signin", pillar: "lifeos", group: "LifeOS", title: "LifeOS", state: "needs-you", line: "Not signed in on this host" },
      ],
    });
    const request = vi.fn(async (method: string) => {
      if (method === "work.lifeos.signOut") tools = "working";
      return method === "work.health" ? report() : null;
    });
    const linkOf = vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(linkOf).not.toHaveBeenCalledWith("mac");
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("Broken")).toBeTruthy();
    expect(screen.getByText("Still connecting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await settle();
    await settle();
    expect(request.mock.calls.map((c) => c[0])).toEqual(["work.health", "work.lifeos.signOut", "work.health"]);
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("a row whose fix is OneDrive's sign-in on the Windows VM brings it up on the row's host, spinning meanwhile, then checks again", async () => {
    let release!: () => void;
    signInOnVm.mockImplementationOnce(() => new Promise((done) => (release = () => done({ computer: "vm:windows", account: null, line: "" }))));
    const request = vi.fn(async () => ({
      host: "env_box",
      at: 1,
      rows: [{ id: "office.onedrive:vm", pillar: "office", group: "Teams files", title: "OneDrive on the Windows VM", state: "needs-you", line: "Signed out", fix: { kind: "page", label: "Sign in…", page: "windows-vm-sign-in" } }],
    }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Sign in…" }));
    await settle();
    expect(signInOnVm).toHaveBeenCalledWith("box");
    expect((screen.getByRole("button", { name: "Sign in…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("checks a host again when its link comes back, never showing its old rows as now", async () => {
    const request = vi.fn(async () => ({ host: "env_box", at: 1, rows: [] }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    const view = render(<ConnectionsPage />);
    await settle();
    links.box = "offline";
    view.rerender(<ConnectionsPage />);
    await settle();
    expect(screen.getAllByText("Offline")).toHaveLength(2);
    links.box = "open";
    view.rerender(<ConnectionsPage />);
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
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
