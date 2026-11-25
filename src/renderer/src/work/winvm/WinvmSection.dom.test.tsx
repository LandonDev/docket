// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WinvmPoint, WinvmState } from "@shared/contract-work-winvm";
import { registry } from "../../lib/connection";
import type { VmOfficeStatus } from "@shared/contract-work-office";
import { GIVEN_KEY, READ_KEY, resetTestKey, testKey } from "../../lib/linkMay.testkit";
import { TURN_OFF, TURN_ON, WinvmSection, WinvmWorkspaceRow, evaluationLine, officeLine, onedriveLine, pointsOf, stateOf, winvmRow } from "./WinvmSection";
import { confirmAction } from "../../chrome/ConfirmDialog";

vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));

const signInOnVm = vi.hoisted(() => vi.fn(async (_env: string) => ({ computer: "vm:windows", account: null, line: "" })));
vi.mock("./signIn", () => ({ signInOnVm }));

const h = vi.hoisted(() => ({ office: null as unknown, screen: "1280x800", state: null as unknown, points: [] as unknown[], pointsFail: null as string | null, pointsHold: null as Promise<unknown> | null, fail: {} as Record<string, string>, calls: [] as { method: string; params: unknown }[], pushes: [] as ((p: unknown) => void)[], confirm: true }));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({ ...(await original<typeof import("../../chrome/ConfirmDialog")>()), confirmAction: vi.fn(async () => h.confirm) }));

const at = (s: Partial<WinvmState>): WinvmState => ({ state: "asleep", step: null, error: null, cannot: null, sleepAfter: "30m", since: 1, ...s });
const flush = () => act(async () => {});

beforeEach(() => {
  h.screen = "1280x800";
  h.state = at({});
  h.points = [];
  h.pointsFail = null;
  h.pointsHold = null;
  h.fail = {};
  h.calls = [];
  h.pushes = [];
  h.confirm = true;
  h.office = null;
  signInOnVm.mockClear();
  vi.spyOn(registry, "linkOf").mockImplementation(
    () =>
      ({
        request: async (method: string, params: unknown) => {
          h.calls.push({ method, params });
          if (method === "work.winvm.state") return h.state;
          if (method === "work.winvm.points" && h.pointsHold) return h.pointsHold;
          if (method === "work.winvm.points") return h.pointsFail ? Promise.reject(new Error(h.pointsFail)) : { points: h.points };
          if (h.fail[method]) throw new Error(h.fail[method]);
          if (method === "work.office.vmStatus") return h.office ?? Promise.reject(new Error("not handled"));
          if (method === "work.office.filesLibraries") return { host: "box", libraries: [{ vm: true, kind: "channels" }], roots: [], off: [] };
          if (method === "work.winvm.settings") {
            const next = (params as { screen?: string }).screen;
            if (next) h.screen = next;
            return { sleepAfter: "30m", screen: h.screen, detail: "sharp" };
          }
          return null;
        },
        onPush: (fn: (p: unknown) => void) => (h.pushes.push(fn), () => undefined),
        onOpen: () => () => undefined,
      }) as never,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetTestKey();
});
const pressed = () => h.calls.filter((c) => !["work.winvm.state", "work.winvm.points", "work.winvm.settings", "work.office.vmStatus", "work.office.filesLibraries"].includes(c.method)).map((c) => c.method);
const status = (over: Partial<VmOfficeStatus> = {}): VmOfficeStatus => ({ office: null, onedrive: { kind: "vm", state: "ok", account: "landon@purdue.edu" }, at: 1, ...over });

describe("the Windows VM in Settings → Work", () => {
  it("says its state in a few words with the one press that fits", () => {
    expect(winvmRow(at({ state: "none" }))).toEqual({ words: "Not set up", press: "setup", busy: false });
    expect(winvmRow(at({ state: "asleep" }))).toMatchObject({ words: "Asleep", press: "wake" });
    // an answer that is no state or no list of points is a failed read, never drawn (a test's link answered LifeOS's status)
    expect(() => stateOf({ lifeos: { state: "signed-out" }, keys: [] })).toThrow("not the Windows VM's state");
    expect(() => pointsOf({ lifeos: {} })).toThrow("not a list of restore points");
    expect(stateOf(at({ state: "awake" })).state).toBe("awake");
    expect(pointsOf({ points: [] })).toEqual([]);
    // a state it does not know (a newer host, or an answer that is no state) has a row and no press, never a crash
    expect(winvmRow(at({ state: "rebuilding" as never }))).toEqual({ words: "Not known", press: null, busy: false });
    expect(winvmRow(at({ state: undefined as never, step: "Doing something new" }))).toMatchObject({ words: "Doing something new", press: null });
    expect(winvmRow(at({ state: "awake" }))).toMatchObject({ words: "Awake", press: "sleep" });
    expect(winvmRow(at({ state: "setting-up", step: "Copying TempCode's helper into Windows" }))).toEqual({ words: "Copying TempCode's helper into Windows", press: null, busy: true });
    expect(winvmRow(at({ state: "waking", step: "Waking the Windows VM" }))).toMatchObject({ press: null, busy: true });
    expect(evaluationLine("2027-02-17")).toMatch(/^Windows 11 Enterprise evaluation, ends about .*2027$/);
  });

  it("names each host by its name mid-line when two have one, never by its link's id", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => (id === "env_box1" ? ({ id, name: "The box" } as never) : undefined));
    render(<WinvmSection hosts={["env_box1", "env_gone"]} />);
    await flush();
    expect(screen.getByText("Windows VM on the box")).not.toBeNull();
    expect(screen.getByText("Windows VM on a host not linked here")).not.toBeNull();
    expect(document.body.textContent).not.toContain("env_");
  });

  it("shows nothing on a host that cannot have it", async () => {
    h.state = at({ state: "none", cannot: "The Windows VM runs on the box." });
    const { container } = render(<WinvmSection hosts={["mac"]} />);
    await flush();
    expect(container.textContent).toBe("");
  });

  it("sets it up with one press, and offers nothing else until it is", async () => {
    h.state = at({ state: "none" });
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.getByText("Not set up")).not.toBeNull();
    expect(screen.queryByText("Restore points")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    await flush();
    expect(pressed()).toEqual(["work.winvm.setup"]);
    // the keeper's push moves the row on
    act(() => h.pushes.forEach((p) => p({ push: "work.winvm", state: at({ state: "setting-up", step: "Making the disk" }) })));
    expect(screen.getByText("Making the disk")).not.toBeNull();
  });

  it("wakes it, sets when it sleeps, and goes back to a point only after a confirm", async () => {
    h.points = [{ id: "p1", name: "Before setup", at: Date.UTC(2026, 10, 23, 17) - 60_000, by: "keeper" } satisfies WinvmPoint];
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    await flush();
    expect(pressed()).toEqual(["work.winvm.wake"]);
    fireEvent.click(screen.getByRole("button", { name: "Restore points" }));
    await flush();
    h.confirm = false;
    fireEvent.click(screen.getByRole("button", { name: "Go back…" }));
    await flush();
    expect(pressed()).toEqual(["work.winvm.wake"]);
    h.confirm = true;
    fireEvent.click(screen.getByRole("button", { name: "Go back…" }));
    await flush();
    expect(h.calls.at(-1)).toEqual({ method: "work.winvm.point.restore", params: { id: "p1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save a point" }));
    await flush();
    expect(h.calls.at(-1)?.method).toBe("work.winvm.point.save");
  });

  it("a given computer's key wakes it and saves a point; Set up, the settings, Go back and Delete are not drawn", async () => {
    testKey.current = GIVEN_KEY;
    h.state = at({ state: "none" });
    const v = render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.getByText("Not set up")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
    v.unmount();
    h.state = at({ state: "asleep" });
    h.points = [{ id: "p1", name: "Before setup", at: Date.UTC(2026, 10, 23, 17) - 60_000, by: "keeper" } satisfies WinvmPoint];
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    // the setting stands as words; the admin read of the settings is never asked
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("30 minutes")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore points" }));
    await flush();
    expect(screen.queryByRole("button", { name: "Go back…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save a point" }));
    await flush();
    expect(pressed()).toEqual(["work.winvm.wake", "work.winvm.point.save"]);
    expect(h.calls.some((c) => c.method === "work.winvm.settings")).toBe(false);
  });

  it("a read key watches it: no press at all", async () => {
    testKey.current = READ_KEY;
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.getByText("Asleep")).not.toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("sets the screen size from the two offered, used by a new Set up", async () => {
    h.state = at({ state: "awake" });
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    const pick = screen.getByRole("combobox", { name: "Screen size" });
    expect(pick.textContent).toContain("1280 × 800");
    // an awake machine keeps the size it woke with
    expect(screen.getByText("Used when the VM is set up again")).not.toBeNull();
    await act(async () => {
      fireEvent.click(pick);
    });
    const option = await screen.findByRole("option", { name: "1920 × 1200" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    expect(h.calls).toContainEqual({ method: "work.winvm.settings", params: { screen: "1920x1200" } });
    expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("1920 × 1200");
  });

  it("offers no screen size before it is set up, and says no wake while it sleeps", async () => {
    h.state = at({ state: "none" });
    const v = render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.queryByRole("combobox", { name: "Screen size" })).toBeNull();
    v.unmount();
    h.state = at({ state: "asleep" });
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.getByRole("combobox", { name: "Screen size" })).not.toBeNull();
    expect(screen.queryByText("From the next wake")).toBeNull();
  });

  it("gives a workspace its switch only where its host has the VM set up", async () => {
    const change = vi.fn(async () => true);
    h.state = at({ state: "none" });
    const v = render(<WinvmWorkspaceRow env="box" on={false} onChange={change} />);
    await flush();
    expect(screen.queryByRole("switch")).toBeNull();
    v.unmount();
    h.state = at({ state: "asleep" });
    render(<WinvmWorkspaceRow env="box" on={false} onChange={change} />);
    await flush();
    fireEvent.click(screen.getByRole("switch", { name: "Computer use on the Windows VM" }));
    await flush();
    expect(change).toHaveBeenCalledWith(true);
  });
  it("says Office in the VM as last read: not installed, which apps and who, or the sign-in to finish", () => {
    expect(officeLine(status())).toEqual({ words: "Not read yet" });
    expect(officeLine(status({ office: { installed: false, version: null, apps: [], account: null, licensed: null } }))).toEqual({ words: "Not installed" });
    const apps = { installed: true, version: "16.0", apps: ["excel", "word", "powerpoint", "outlook"] as const, licensed: true };
    expect(officeLine(status({ office: { ...apps, apps: [...apps.apps], account: "landon@purdue.edu" } }))).toEqual({ words: "Excel, Word and PowerPoint, signed in as landon@purdue.edu" });
    expect(officeLine(status({ office: { ...apps, apps: [...apps.apps], account: null } }))).toEqual({ words: "Excel, Word and PowerPoint. Sign in to finish", signIn: true });
  });

  it("says OneDrive in the VM: who and how many Teams libraries, or the sign-in", () => {
    expect(onedriveLine(status(), 3)).toEqual({ words: "Signed in as landon@purdue.edu, 3 Teams libraries" });
    expect(onedriveLine(status(), 1)?.words).toBe("Signed in as landon@purdue.edu, 1 Teams library");
    expect(onedriveLine(status({ onedrive: { kind: "vm", state: "no-libraries", account: "landon@purdue.edu" } }), 0)?.words).toBe("Signed in as landon@purdue.edu, no Teams library synced yet");
    expect(onedriveLine(status({ onedrive: { kind: "vm", state: "signed-out", account: null } }), null)).toEqual({ words: "Signed out", signIn: true });
    expect(onedriveLine(status({ onedrive: { kind: "vm", state: "not-set-up", account: null } }), null)).toBeNull();
  });

  it("says a failed read of the restore points with Retry, and None yet only after a true empty answer", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.pointsFail = "No answer in 4 s";
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.getByText("The box did not answer. Try again once it is connected.")).toBeTruthy();
    expect(screen.queryByText("None yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore points" })).toBeNull();
    h.pointsFail = "work.winvm.points: socket hung";
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.getByText("The box could not read the restore points.")).toBeTruthy();
    h.pointsFail = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.getByText("None yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps the points' failure with its Retry spinning until the points answer, never a bone", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.pointsFail = "work.winvm.points: socket hung";
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    let land!: (v: unknown) => void;
    h.pointsHold = new Promise((r) => (land = r));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.getByText("The box could not read the restore points.")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    expect(document.querySelector("[data-points-bone]")).toBeNull();
    await act(async () => land({ points: [] }));
    expect(screen.getByText("None yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps the machine's failure with its Retry spinning until the host answers", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    let answer!: (v: unknown) => void;
    const request = vi.fn(async (method: string) => {
      if (method !== "work.winvm.state") return Promise.reject(new Error("not handled"));
      return request.mock.calls.filter(([m]) => m === "work.winvm.state").length === 1 ? Promise.reject(new Error("No answer in 4 s")) : new Promise((r) => (answer = r));
    });
    vi.spyOn(registry, "linkOf").mockReturnValue({ request, onPush: () => () => undefined, onOpen: () => () => undefined } as never);
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    const line = screen.getByText("The box did not answer. Try again once it is connected.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(line.isConnected).toBe(true);
    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    await act(async () => answer(at({ state: "asleep" })));
    expect(screen.queryByText("The box did not answer. Try again once it is connected.")).toBeNull();
  });

  it("holds the count's line with a bone while the points are read, then the count in its place", async () => {
    let land!: (v: unknown) => void;
    h.pointsHold = new Promise((r) => (land = r));
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    const row = screen.getByText("Restore points").closest("[data-slot=page-row]") as HTMLElement;
    expect(within(row).getByRole("status", { name: "Reading restore points" }).className).toContain("h-4");
    await act(async () => land({ points: [] }));
    expect(within(row).queryByRole("status", { name: "Reading restore points" })).toBeNull();
    expect(within(row).getByText("None yet")).toBeTruthy();
  });

  it("says a refused press in his words, naming the computer, never the link's text", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.fail["work.winvm.wake"] = "work.winvm.wake: guest door refused (code 7)";
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    await flush();
    expect(screen.getByText("The box did not wake the Windows VM.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("guest door");
  });

  it("offers OneDrive's sign-in once, on its row, and draws no Office row for a host that cannot say", async () => {
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.queryByText("Office")).toBeNull();
    cleanup();
    h.office = status({ onedrive: { kind: "vm", state: "signed-out", account: null }, office: { installed: true, version: "16.0", apps: ["excel"], account: null, licensed: null } });
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(await screen.findByText("Signed out")).toBeTruthy();
    expect(screen.getByText("Excel. Sign in to finish")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
    expect(signInOnVm).toHaveBeenCalledWith("box");
  });
});

describe("Live resize in Settings → Work", () => {
  const vga = { device: "vga", width: 1280, height: 800, scale: 100, fit: false, detail: "sharp", canResize: false } as const;
  const virtio = { ...vga, device: "virtio", width: 2560, height: 1600, scale: 200, fit: true, canResize: true } as const;

  it("turns it on after the confirm in the plan's words; the row says each step while it runs, the Windows row only that it is busy", async () => {
    h.state = at({ state: "awake", display: vga });
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.getByText("Off")).not.toBeNull();
    // on std VGA a size is a new Set up's, and Detail waits for live resize
    expect(screen.getByText("Used when the VM is set up again")).not.toBeNull();
    expect(screen.queryByRole("combobox", { name: "Detail" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn on…" })));
    expect(confirmAction).toHaveBeenCalledWith(TURN_ON);
    expect(TURN_ON.body).toBe("Windows restarts once. Save your work in it first. Sign-ins stay. A restore point is saved first, in place of your oldest if you have three.");
    expect(pressed()).toEqual(["work.winvm.display.upgrade"]);
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "setting-up", step: "Saving a restore point", display: vga }) })));
    expect(screen.getByText("Saving a restore point")).not.toBeNull();
    expect(screen.getByText("Changing its display")).not.toBeNull();
    expect((screen.getByRole("button", { name: /Turn on/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(winvmRow(at({ state: "setting-up", step: "Restarting Windows" }))).toEqual({ words: "Changing its display", press: null, busy: false });
  });

  it("a refusal is the row's red line, and a Cancel sends nothing", async () => {
    h.state = at({ state: "awake", display: vga });
    h.fail["work.winvm.display.upgrade"] = "A thread is using the Windows VM. Stop it or take over first.";
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    h.confirm = false;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn on…" })));
    expect(pressed()).toEqual([]);
    h.confirm = true;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn on…" })));
    expect(document.body.textContent).toContain("A thread is using the Windows VM");
  });

  it("on virtio: Turn off… after its own confirm, Fit to window and 2560 × 1600 offered with no Set up line, and Detail", async () => {
    h.state = at({ state: "awake", display: virtio });
    h.screen = "fit";
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.getByText("On")).not.toBeNull();
    expect(screen.queryByText("Used when the VM is set up again")).toBeNull();
    const pick = screen.getByRole("combobox", { name: "Screen size" });
    expect(pick.textContent).toContain("Fit to window");
    await act(async () => fireEvent.click(pick));
    const option = await screen.findByRole("option", { name: "2560 × 1600" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    expect(h.calls).toContainEqual({ method: "work.winvm.settings", params: { screen: "2560x1600" } });
    const detail = screen.getByRole("combobox", { name: "Detail" });
    expect(detail.textContent).toContain("Sharp");
    await act(async () => fireEvent.click(detail));
    const faster = await screen.findByRole("option", { name: "Faster" });
    await act(async () => {
      fireEvent.pointerDown(faster, { pointerType: "mouse" });
      fireEvent.click(faster);
    });
    expect(h.calls).toContainEqual({ method: "work.winvm.settings", params: { detail: "faster" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn off…" })));
    expect(confirmAction).toHaveBeenLastCalledWith(TURN_OFF);
    expect(pressed()).toEqual(["work.winvm.display.downgrade"]);
  });

  it("a key that is not an admin's reads On or Off with no press; a host before live resize has no row", async () => {
    testKey.current = GIVEN_KEY;
    h.state = at({ state: "awake", display: virtio });
    const v = render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.getByText("Live resize")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Turn (on|off)/ })).toBeNull();
    v.unmount();
    resetTestKey();
    h.state = at({ state: "awake" });
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.queryByText("Live resize")).toBeNull();
  });
});
