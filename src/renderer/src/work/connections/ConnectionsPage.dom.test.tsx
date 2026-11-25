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
const { ConnectionsPage, ConnectionsView, forgetReports } = await import("./ConnectionsPage");
const { FirstCheckBones } = await import("./FirstCheckBones");
const { resetLifeos, setLifeosStatus } = await import("../shell/lifeos");
const { Page } = await import("../../components/page");

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

afterEach(() => {
  forgetReports();
  links.box = "open";
  cleanup();
  resetLifeos();
  vi.restoreAllMocks();
  resetTestKey();
});

describe("Connections", () => {
  it("opens on each host's last report, every row still checking, and asks fresh on his Check again and after a fix", async () => {
    forgetReports();
    const request = vi.fn(async (): Promise<HealthReport> => ({
      host: "env_box",
      at: 1,
      rows: [{ id: "lifeos.signin", pillar: "lifeos", group: "LifeOS", title: "LifeOS", state: "working", line: "Signed in" }],
    }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    const first = render(<ConnectionsPage />);
    await settle();
    // The page's open may be answered from the host's last few seconds.
    expect(request.mock.calls.map((c) => (c as unknown[])[1])).toEqual([{}]);
    first.unmount();
    render(
      <Page title="Connections">
        <ConnectionsPage />
      </Page>,
    );
    // Its first commit: the last report's rows, with no answer yet.
    expect(screen.getByText("Signed in")).toBeTruthy();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect((request.mock.calls.at(-1) as unknown[])[1]).toEqual({ fresh: true });
  });

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
          ? { id: "lifeos.signin", pillar: "lifeos", group: "LifeOS", title: "LifeOS", state: "broken", lifeos: "connecting", line: "Still connecting to LifeOS", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }
          : { id: "lifeos.signin", pillar: "lifeos", group: "LifeOS", title: "LifeOS", state: "needs-you", lifeos: "signed-out", line: "Not signed in to LifeOS" },
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
    expect(screen.getByText("LifeOS is still connecting on the box")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await settle();
    await settle();
    expect(request.mock.calls.map((c) => c[0])).toEqual(["work.health", "work.lifeos.signOut", "work.health"]);
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("Not signed in to LifeOS on the box")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("offers a given computer's key no LifeOS sign-in or sign-out, and keeps the fixes it may run", async () => {
    testKey.current = GIVEN_KEY;
    const request = vi.fn(async () => ({
      host: "env_box",
      at: 1,
      rows: [
        { id: "lifeos.signin", pillar: "lifeos", group: "LifeOS", title: "LifeOS", state: "working", line: "Signed in", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } },
        { id: "lifeos.pair", pillar: "lifeos", group: "LifeOS", title: "LifeOS on the Mac", state: "needs-you", line: "Not signed in", fix: { kind: "page", label: "Sign in", page: "lifeos-sign-in" } },
        { id: "office.onedrive:vm", pillar: "office", group: "Teams files", title: "OneDrive on the Windows VM", state: "needs-you", line: "Signed out", fix: { kind: "page", label: "Sign in to OneDrive", page: "windows-vm-sign-in" } },
      ],
    }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in to OneDrive" })).toBeTruthy();
  });

  /** Council round 7 (Sol, Settings 2): the sign-in's press went from a row that needs him with no line saying who can. */
  it("says who can under a row that needs him where this window may not make its fix, by the act, and under no working row", async () => {
    testKey.current = GIVEN_KEY;
    vi.spyOn(registry, "environment").mockReturnValue({ id: "box", name: "The box" } as never);
    const request = vi.fn(async () => ({
      host: "env_box",
      at: 1,
      rows: [
        { id: "lifeos.signin", pillar: "lifeos", group: "LifeOS", title: "LifeOS", state: "needs-you", lifeos: "signed-out", line: "Not signed in to LifeOS", fix: { kind: "page", label: "Sign in", page: "lifeos-sign-in" } },
        { id: "lifeos.other", pillar: "lifeos", group: "LifeOS", title: "LifeOS on the Mac", state: "working", line: "Signed in", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } },
      ],
    }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(document.querySelectorAll("[data-who-can]").length).toBe(1);
    expect(screen.getByText("Sign in from a computer that manages the box")).toBeTruthy();
  });

  /** Council round 8 (Opus Settings 1, Sol Settings 2): LifeOS's silence named no computer and had no way back. */
  it("says LifeOS's silence with its computer named, and its Retry asks that host again, alone, spinning meanwhile", async () => {
    let release!: () => void;
    let asks = 0;
    const request = vi.fn(
      (): Promise<HealthReport> =>
        new Promise((done) => {
          const report: HealthReport = {
            host: "env_box",
            at: 1,
            rows: [
              { id: "lifeos.signin", pillar: "lifeos", group: "LifeOS", title: "LifeOS", state: "working", lifeos: "connected", line: "Signed in", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } },
              { id: "lifeos.answers", pillar: "lifeos", group: "LifeOS", title: "LifeOS answers", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer" },
            ],
          };
          if (++asks === 1) done(report);
          else release = () => done(report);
        }),
    );
    const linkOf = vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    // Two hosts listed: the line that words the state names its computer; the row whose line does not, its title.
    expect(screen.getByText("LifeOS did not answer the box")).toBeTruthy();
    expect(screen.getByText("LifeOS on the box", { selector: "[data-slot=item-title]" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    // The long sentence keeps its room in a narrow window: its press takes a line of its own there.
    expect(screen.getByText("LifeOS did not answer the box").closest("[data-slot=page-row]")!.hasAttribute("data-wide")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(request.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["work.health", "work.health"]);
    // The health asks went to the box alone ("local" is this window's own link, read by the key check).
    expect(linkOf.mock.calls.map(([id]) => id).filter((id) => id !== "local")).toEqual(["box", "box"]);
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    await settle();
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);
  });

  /** Council round 9 (Sol, Settings 1): the box itself said LifeOS was unreachable, and its row offered Sign out alone. */
  it("gives the sign-in row of a host that says LifeOS is unreachable that host's Retry, beside its Sign out, as it was", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2 * 3_600_000);
    const request = vi.fn(async (method: string): Promise<HealthReport | null> =>
      method === "work.health"
        ? { host: "env_box", at: 1, rows: [{ id: "lifeos.signin", pillar: "lifeos", group: "LifeOS", title: "LifeOS", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer. Still trying since", at: 3_600_000, fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }] }
        : null,
    );
    const linkOf = vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(screen.getByText(/^LifeOS did not answer the box\. Still trying since/)).toBeTruthy();
    const buttons = [...screen.getByText(/^LifeOS did not answer the box/).closest("[data-slot=page-row]")!.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Retry", "Sign out"]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    // Retry asks that host's checks again, that host alone; Sign out is not pressed.
    expect(request.mock.calls.map((c) => c[0])).toEqual(["work.health", "work.health"]);
    expect(linkOf.mock.calls.map(([id]) => id).filter((id) => id !== "local")).toEqual(["box", "box"]);
  });

  /** Council round 9 (Sol, Settings 2): Retry on LifeOS's silence, the host silent too: two rows, two causes, two Retries. */
  it("says a host's silence on its Retry once, in the Hosts row, the old LifeOS row gone, and the row back when it answers", async () => {
    let silent = false;
    const report: HealthReport = {
      host: "env_box",
      at: 1,
      rows: [
        { id: "lifeos.signin", pillar: "lifeos", group: "LifeOS", title: "LifeOS", state: "working", lifeos: "connected", line: "Signed in", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } },
        { id: "lifeos.answers", pillar: "lifeos", group: "LifeOS", title: "LifeOS answers", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer" },
      ],
    };
    const request = vi.fn(async () => (silent ? Promise.reject(new Error("No answer in 4 s")) : report));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(screen.getByText("LifeOS did not answer the box")).toBeTruthy();
    silent = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByText("Did not answer")).toBeTruthy();
    expect(screen.queryByText("LifeOS did not answer the box")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    // Its other rows stay as the last check left them, Sign out with them.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    silent = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.queryByText("Did not answer")).toBeNull();
    expect(screen.getByText("LifeOS did not answer the box")).toBeTruthy();
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

  /** Council round 8 (the walk, after Sol Settings 1): a LifeOS row stayed signed out after he signed in elsewhere. */
  it("checks a host again when its LifeOS state changes, so its LifeOS rows are true with no press", async () => {
    setLifeosStatus("box", { lifeos: { state: "signed-out" }, keys: [] });
    const request = vi.fn(async () => ({ host: "env_box", at: 1, rows: [] }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request, onPush: () => () => {}, onOpen: () => () => {}, connected: true } as never);
    render(<ConnectionsPage />);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => setLifeosStatus("box", { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] }));
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    // The same state again asks nothing.
    await act(async () => setLifeosStatus("box", { lifeos: { state: "connected", ownerId: "landon", since: 2 }, keys: [] }));
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

  /** Council round 10 (Sol Settings 1, Opus Settings 2): the Hosts row vanished while its check ran, and Check again spun. */
  it("keeps a Hosts row in place while its Retry checks, spinning that Retry alone, and a new cause replaces the reason", async () => {
    let answer: (err: Error) => void = () => {};
    let asks = 0;
    const request = vi.fn(() => (++asks === 1 ? Promise.reject(new Error("Work is off on this host")) : new Promise((_, no) => (answer = no))));
    vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
    render(
      <Page title="Connections">
        <ConnectionsPage />
      </Page>,
    );
    await settle();
    const retry = () => document.querySelector<HTMLButtonElement>("[data-host-retry]")!;
    expect(retry().className).toContain("secondary");
    fireEvent.click(retry());
    await settle();
    // The row stands, its words as they were, its Retry spinning; Check again does not spin for it.
    expect(screen.getByText("Not checked")).toBeTruthy();
    expect(screen.getByText("Work is off on the box. Turn it on in Settings, Work.")).toBeTruthy();
    expect(retry().disabled).toBe(true);
    expect(retry().querySelector("[data-busy]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Check again" }).querySelector("[data-busy]")).toBeNull();
    await act(async () => answer(new Error("No answer in 4 s")));
    await settle();
    expect(screen.getByText("Did not answer")).toBeTruthy();
    expect(screen.queryByText(/Work is off/)).toBeNull();
    expect(retry().disabled).toBe(false);
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
