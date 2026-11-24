// @vitest-environment jsdom
/** Settings → Connections: checks each linked host when it opens, says an unlinked host is offline, and a fix's press runs it on the row's host, then checks that host again. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncWhen } from "@shared/work/messages";
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

vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));
const { GIVEN_KEY, resetTestKey, testKey } = await import("../../lib/linkMay.testkit");
const { ConnectionsPage, ConnectionsView } = await import("./ConnectionsPage");
const { FirstCheckBones } = await import("./FirstCheckBones");
const { Page } = await import("../../components/page");

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

afterEach(() => {
  links.box = "open";
  cleanup();
  vi.restoreAllMocks();
  resetTestKey();
});

describe("Connections", () => {
  it("words a host's sync instant on the window's clock", async () => {
    const at = Date.UTC(2026, 10, 23, 20, 14);
    const now = at + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const request = vi.fn(async (): Promise<HealthReport> => ({
      host: "env_box",
      at: now,
      rows: [{ id: "lifeos.source:mail", pillar: "lifeos", group: "Mail and calendar", title: "Purdue mail", state: "working", line: "Synced", at }],
    }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(screen.getByText(`Synced ${syncWhen(at, now)}`)).toBeTruthy();
  });

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

  it("offers a given computer's key no LifeOS sign-in or sign-out, and keeps the fixes it may run", async () => {
    testKey.current = GIVEN_KEY;
    const request = vi.fn(async () => ({
      host: "env_box",
      at: 1,
      rows: [
        { id: "lifeos.signin", pillar: "lifeos", group: "LifeOS", title: "LifeOS", state: "working", line: "Signed in", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } },
        { id: "lifeos.pair", pillar: "lifeos", group: "LifeOS", title: "LifeOS on the Mac", state: "needs-you", line: "Not signed in", fix: { kind: "page", label: "Sign in…", page: "lifeos-sign-in" } },
        { id: "office.onedrive:vm", pillar: "office", group: "Teams files", title: "OneDrive on the Windows VM", state: "needs-you", line: "Signed out", fix: { kind: "page", label: "Sign in to OneDrive", page: "windows-vm-sign-in" } },
      ],
    }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in to OneDrive" })).toBeTruthy();
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

  it("says a host that refuses was not checked, never that it did not answer, with the refusal's words and Retry", async () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({ request: vi.fn(async () => Promise.reject(new Error("Work is off on this host"))) } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(screen.getByText("Not checked")).toBeTruthy();
    expect(screen.queryByText("Did not answer")).toBeNull();
    expect(screen.getByText("Work is off on the box. Turn it on in Settings, Work.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says a host that did not answer once, with no detail that says it again", async () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({ request: vi.fn(async () => Promise.reject(new Error("No answer in 4 s"))) } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(screen.getByText("Did not answer")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/did not answer.*did not answer/i);
  });

  it("turns Check again off while no host is linked, the rows saying each is offline", async () => {
    links.box = "offline";
    vi.spyOn(registry, "linkOf").mockReturnValue({ request: vi.fn() } as never);
    // Check again sits on the page's title line, so the page is drawn around it.
    render(
      <Page title="Connections">
        <ConnectionsPage />
      </Page>,
    );
    await settle();
    expect(screen.getAllByText("Offline")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets a row's state line wrap in a narrow window, never cutting the fix's words", async () => {
    const request = vi.fn(async () => ({ host: "env_box", at: 1, rows: [{ id: "google", pillar: "google", group: "Google", title: "Google", state: "broken", line: "Google refused the token: sign in again in LifeOS" }] }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    const mark = screen.getByText("Broken").closest("[data-slot=status-mark]")!;
    expect(mark.className).toContain("[&>[data-slot=status-detail]]:whitespace-normal");
    expect(mark.className.split(" ")).toContain("flex");
    // The glyph keeps the word's first line when the detail wraps, never the block's middle.
    expect(mark.className).toContain("[&>[data-slot=status-glyph]]:self-start");
  });

  /** Opus round 3 P3: a row that ends on a date gives its date and press a line of their own under 480px of page. */
  it("draws a row that ends on a date as a wide row, and a row with none as a plain one", async () => {
    const until = Date.UTC(2027, 1, 17, 23, 59);
    const request = vi.fn(async () => ({
      host: "env_box",
      at: 1,
      rows: [
        { id: "winvm", pillar: "winvm", group: "Windows VM", title: "Windows VM", state: "working", line: "Stopped, its disk is ready", until },
        { id: "google", pillar: "google", group: "Google", title: "Google", state: "working", line: "Signed in" },
      ],
    }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    const row = (title: string) => screen.getByText(title, { selector: "[data-slot=item-title]" }).closest("[data-slot=page-row]")!;
    expect(row("Windows VM").hasAttribute("data-wide")).toBe(true);
    expect(row("Windows VM").querySelector("[data-wide-control]")?.textContent).toMatch(/^Ends /);
    expect(row("Google").hasAttribute("data-wide")).toBe(false);
  });

  it("draws the same bones while its chunk loads as while the first check is out, so nothing changes shape", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // The settings page's fallback for the chunk is the page's own first-check bones.
    expect(readFileSync(join(import.meta.dirname, "../../surfaces/SettingsView.tsx"), "utf8")).toContain('connectionsChunk.surface("ConnectionsPage", <FirstCheckBones />)');
    const page = render(<ConnectionsView hosts={[{ id: "box", name: "the box", status: "checking" }]} onRecheck={() => {}} />);
    const first = page.container.innerHTML;
    page.unmount();
    expect(render(<FirstCheckBones />).container.innerHTML).toBe(first);
  });
});
