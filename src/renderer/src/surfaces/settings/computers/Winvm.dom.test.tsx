// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WinvmPoint, WinvmState } from "@shared/contract-work-winvm";
import { registry } from "../../../lib/connection";
import { NO_ANSWER } from "../../../lib/connection/openRead";
import { GIVEN_KEY, READ_KEY, resetTestKey, testKey } from "../../../lib/linkMay.testkit";
import { TURN_ON, WinvmHost, WinvmPage, WinvmWorkspaceRow, pointsOf, stateOf, winvmRow } from "./Winvm";
import { tellSettingsList } from "../../../lib/settings/useListWindow";
import { resetUpgradesForTests, upgradeWorked } from "./winvmUpgrade";
import { confirmAction } from "../../../chrome/ConfirmDialog";

vi.mock("../../../lib/linkMay", async (original) => (await import("../../../lib/linkMay.testkit")).linkMayMock(await original()));


const h = vi.hoisted(() => ({ office: null as unknown, screen: "1280x800", state: null as unknown, points: [] as unknown[], pointsFail: null as string | null, pointsHold: null as Promise<unknown> | null, fail: {} as Record<string, string>, calls: [] as { method: string; params: unknown }[], pushes: [] as ((p: unknown) => void)[], confirm: true, settingsRead: "answers" as "answers" | "pending" | "refused", settingsWriteFail: null as string | null, settingsWriteHold: null as Promise<unknown> | null, opens: [] as (() => void)[] }));
vi.mock("../../../chrome/ConfirmDialog", async (original) => ({ ...(await original<typeof import("../../../chrome/ConfirmDialog")>()), confirmAction: vi.fn(async () => h.confirm) }));

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
  h.settingsRead = "answers";
  h.settingsWriteFail = null;
  h.settingsWriteHold = null;
  h.opens = [];
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
          if (method === "work.winvm.settings" && Object.keys(params as object).length === 0 && h.settingsRead === "pending") return new Promise(() => {});
          if (method === "work.winvm.settings" && Object.keys(params as object).length === 0 && h.settingsRead === "refused") throw new Error(NO_ANSWER);
          if (method === "work.winvm.settings" && Object.keys(params as object).length > 0 && h.settingsWriteHold) return h.settingsWriteHold;
          if (method === "work.winvm.settings" && Object.keys(params as object).length > 0 && h.settingsWriteFail) throw new Error(h.settingsWriteFail);
          if (method === "work.winvm.settings") {
            const next = (params as { screen?: string }).screen;
            if (next) h.screen = next;
            return { sleepAfter: "30m", screen: h.screen, detail: "sharp" };
          }
          return null;
        },
        onPush: (fn: (p: unknown) => void) => (h.pushes.push(fn), () => undefined),
        onOpen: (fn: () => void) => (h.opens.push(fn), () => undefined),
      }) as never,
  );
});
afterEach(() => {
  cleanup();
  resetUpgradesForTests();
  vi.restoreAllMocks();
  resetTestKey();
});
const pressed = () => h.calls.filter((c) => !["work.winvm.state", "work.winvm.points", "work.winvm.settings", "work.office.vmStatus", "work.office.filesLibraries"].includes(c.method)).map((c) => c.method);

describe("Settings › Windows VM", () => {
  it("says its state in a few words with the one press that fits", () => {
    expect(winvmRow(at({ state: "none" }))).toEqual({ words: "Not set up", press: "setup", busy: false });
    expect(winvmRow(at({ state: "asleep" }))).toMatchObject({ words: "Asleep", press: "wake" });
    // the keeper's own wake after a restart of the box's service says so
    expect(winvmRow(at({ state: "waking", step: "Waking after an update…" }))).toEqual({ words: "Waking after an update…", press: null, busy: true });
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
  });

  it("says why on a computer that cannot have it, and where no computer holds one", async () => {
    h.state = at({ state: "none", cannot: "The Windows VM runs on the box." });
    render(<WinvmHost env="mac" />);
    await flush();
    expect(screen.getByText("The Windows VM runs on the box.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    act(() => tellSettingsList({ has: { winvm: false }, vmOn: null }));
    render(<WinvmPage />);
    expect(screen.getByText("No computer here holds a Windows VM")).toBeTruthy();
    cleanup();
    act(() => tellSettingsList({ has: { winvm: true }, vmOn: "box" }));
    h.state = at({ state: "asleep" });
    render(<WinvmPage />);
    await flush();
    expect(screen.getByText("Asleep")).toBeTruthy();
  });

  it("sets it up with one press, and offers nothing else until it is", async () => {
    h.state = at({ state: "none" });
    render(<WinvmHost env="box" />);
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
    render(<WinvmHost env="box" />);
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
    const v = render(<WinvmHost env="box" />);
    await flush();
    expect(screen.getByText("Not set up")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
    v.unmount();
    h.state = at({ state: "asleep" });
    h.points = [{ id: "p1", name: "Before setup", at: Date.UTC(2026, 10, 23, 17) - 60_000, by: "keeper" } satisfies WinvmPoint];
    render(<WinvmHost env="box" />);
    await flush();
    // the setting stands as words; the admin read of the settings is never asked
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("30 minutes")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore points" }));
    await flush();
    expect(screen.queryByRole("button", { name: "Go back…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save a point" }));
    await flush();
    expect(pressed()).toEqual(["work.winvm.wake", "work.winvm.point.save"]);
    expect(h.calls.some((c) => c.method === "work.winvm.settings")).toBe(false);
  });

  it("deletes a point only after a confirm naming it", async () => {
    h.points = [{ id: "p1", name: "Before setup", at: Date.UTC(2026, 10, 23, 17), by: "keeper" } satisfies WinvmPoint];
    render(<WinvmHost env="box" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Restore points" }));
    await flush();
    h.confirm = false;
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    await flush();
    expect(confirmAction).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Delete Before setup?" }));
    expect(h.calls.some((c) => c.method === "work.winvm.point.delete")).toBe(false);
    h.confirm = true;
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    await flush();
    expect(h.calls.at(-1)).toEqual({ method: "work.winvm.point.delete", params: { id: "p1" } });
  });

  it("a read key watches it: no press at all", async () => {
    testKey.current = READ_KEY;
    render(<WinvmHost env="box" />);
    await flush();
    expect(screen.getByText("Asleep")).not.toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("sets the screen size from the two offered, used by a new Set up", async () => {
    h.state = at({ state: "awake" });
    render(<WinvmHost env="box" />);
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
    const v = render(<WinvmHost env="box" />);
    await flush();
    expect(screen.queryByRole("combobox", { name: "Screen size" })).toBeNull();
    v.unmount();
    h.state = at({ state: "asleep" });
    render(<WinvmHost env="box" />);
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
  it("says a failed read of the restore points with Retry, and None yet only after a true empty answer", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.pointsFail = "No answer in 4 s";
    render(<WinvmHost env="box" />);
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
    render(<WinvmHost env="box" />);
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
      return request.mock.calls.filter(([m]) => m === "work.winvm.state").length === 1 ? Promise.reject(new Error(NO_ANSWER)) : new Promise((r) => (answer = r));
    });
    vi.spyOn(registry, "linkOf").mockReturnValue({ request, onPush: () => () => undefined, onOpen: () => () => undefined } as never);
    render(<WinvmHost env="box" />);
    await flush();
    // One line naming the computer (ReadFailure), never the link's raw words.
    const line = document.querySelector("[data-read-failure]")!;
    expect(line.textContent).toMatch(/did not answer\./);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(line.isConnected).toBe(true);
    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    await act(async () => answer(at({ state: "asleep" })));
    expect(document.querySelector("[data-read-failure]")).toBeNull();
  });

  it("stands in as many rows as will land while its state is read", async () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({ request: () => new Promise(() => {}), onPush: () => () => undefined, onOpen: () => () => undefined } as never);
    const { container } = render(<WinvmHost env="box" />);
    await flush();
    expect(container.querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(5);
  });

  it("holds the count's line with a bone while the points are read, then the count in its place", async () => {
    let land!: (v: unknown) => void;
    h.pointsHold = new Promise((r) => (land = r));
    render(<WinvmHost env="box" />);
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
    render(<WinvmHost env="box" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    await flush();
    expect(screen.getByText("The box did not wake the Windows VM.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("guest door");
  });

});

describe("Screen size and picture quality", () => {
  const vga = { device: "vga", width: 1280, height: 800, scale: 100, fit: false, detail: "sharp", canResize: false } as const;
  const virtio = { ...vga, device: "virtio", width: 2560, height: 1600, scale: 200, fit: true, canResize: true } as const;
  const pick = async (name: string, option: string) => {
    await act(async () => fireEvent.click(screen.getByRole("combobox", { name })));
    const item = await screen.findByRole("option", { name: option });
    await act(async () => {
      fireEvent.pointerDown(item, { pointerType: "mouse" });
      fireEvent.click(item);
    });
  };

  it("fits the screen to his window only after the confirm, which turns live resize on; the Windows row says only that its display changes", async () => {
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    // on the old display a size is a new Set up's, and picture quality waits for live resize
    expect(screen.getByText("Used when the VM is set up again")).not.toBeNull();
    expect(screen.queryByRole("combobox", { name: "Picture quality" })).toBeNull();
    h.confirm = false;
    await pick("Screen size", "Fits my window");
    expect(confirmAction).toHaveBeenCalledWith(TURN_ON);
    expect(pressed()).toEqual([]);
    h.confirm = true;
    await pick("Screen size", "Fits my window");
    expect(TURN_ON.body).toBe("Windows restarts once. Save your work in it first. Sign-ins stay. A restore point is saved first, in place of your oldest if you have three.");
    expect(h.calls).toContainEqual({ method: "work.winvm.settings", params: { screen: "fit" } });
    expect(pressed()).toEqual(["work.winvm.display.upgrade"]);
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "setting-up", step: "Saving a restore point", display: vga }) })));
    expect(screen.getByText("Saving a restore point")).not.toBeNull();
    expect(screen.getByText("Changing its display")).not.toBeNull();
    expect(winvmRow(at({ state: "setting-up", step: "Restarting Windows" }))).toEqual({ words: "Changing its display", press: null, busy: false });
  });

  it("says a refused fit in his words", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: vga });
    h.fail["work.winvm.display.upgrade"] = "A thread is using the Windows VM. Stop it or take over first.";
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Screen size", "Fits my window");
    expect(document.body.textContent).toContain("A thread is using the Windows VM");
  });

  it("with live resize on: a size at once with no restart, and the picture quality", async () => {
    h.state = at({ state: "awake", display: virtio });
    h.screen = "fit";
    render(<WinvmHost env="box" />);
    await flush();
    expect(screen.queryByText("Used when the VM is set up again")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("Fits my window");
    await pick("Screen size", "2560 × 1600");
    expect(confirmAction).not.toHaveBeenCalled();
    expect(h.calls).toContainEqual({ method: "work.winvm.settings", params: { screen: "2560x1600" } });
    expect(screen.getByRole("combobox", { name: "Picture quality" }).textContent).toContain("Sharp");
    await pick("Picture quality", "Faster");
    expect(h.calls).toContainEqual({ method: "work.winvm.settings", params: { detail: "faster" } });
    expect(pressed()).toEqual([]);
  });

  it("holds the display's rows as bones while they are read, and says a failed read in the wait's shape with one Retry", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: virtio });
    h.settingsRead = "pending";
    const v = render(<WinvmHost env="box" />);
    await flush();
    expect(v.container.querySelector("[data-setting='winvm.screen'] [data-skeleton-control]")).not.toBeNull();
    expect(v.container.querySelector("[data-setting='winvm.quality'] [data-skeleton-control]")).not.toBeNull();
    cleanup();
    h.settingsRead = "refused";
    const w = render(<WinvmHost env="box" />);
    await flush();
    // Both labels stand, nothing claimed at their ends, and one red line with its Retry under them.
    expect(w.container.querySelector("[data-setting='winvm.screen']")?.textContent).toBe("Screen size");
    expect(w.container.querySelector("[data-setting='winvm.quality']")?.textContent).toBe("Picture quality");
    const line = w.container.querySelector("[data-display-failure]")!.closest("[data-slot=page-error-line]") as HTMLElement;
    expect(line.textContent).toContain("did not answer.");
    expect(w.container.querySelectorAll("[data-display-failure]")).toHaveLength(1);
    // The Windows row is not where it is said.
    expect(w.container.querySelector("[data-setting='winvm.windows']")?.textContent).not.toContain("did not answer");
    h.settingsRead = "answers";
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Retry" })));
    await flush();
    expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("1280 × 800");
    expect(document.querySelector("[data-display-failure]")).toBeNull();
  });

  it("says a failed read again even while the values it read before stand", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: virtio });
    h.screen = "fit";
    render(<WinvmHost env="box" />);
    await flush();
    expect(document.querySelector("[data-display-failure]")).toBeNull();
    // The socket opens again and the read fails: the held values stay, and the failure is said with Retry.
    h.settingsRead = "refused";
    await act(async () => h.opens.forEach((fn) => fn()));
    await flush();
    expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("Fits my window");
    expect(screen.getByRole("combobox", { name: "Picture quality" }).textContent).toContain("Sharp");
    const line = document.querySelector("[data-display-failure]")!.closest("[data-slot=page-error-line]") as HTMLElement;
    expect(line.textContent).toContain("did not answer.");
    h.settingsRead = "answers";
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Retry" })));
    await flush();
    expect(document.querySelector("[data-display-failure]")).toBeNull();
  });

  it("marks each select's save, and a refused fit puts the size that stands back with the reason on its row", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: vga });
    h.fail["work.winvm.display.upgrade"] = "A thread is using the Windows VM. Stop it or take over first.";
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Sleeps after", "2 hours");
    await flush();
    expect(document.querySelector("[data-setting='winvm.sleeps'] [data-slot=save-mark]")?.getAttribute("data-state")).toBe("saved");
    await pick("Screen size", "Fits my window");
    await flush();
    // The fit was saved, the restart refused: the size that stood is written back and shown, the reason on its row.
    expect(h.calls.filter((c) => c.method === "work.winvm.settings" && (c.params as { screen?: string }).screen)).toEqual([
      { method: "work.winvm.settings", params: { screen: "fit" } },
      { method: "work.winvm.settings", params: { screen: "1280x800" } },
    ]);
    expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("1280 × 800");
    expect(document.querySelector("[data-setting='winvm.screen']")?.textContent).toContain("A thread is using the Windows VM");
    expect(document.querySelector("[data-setting='winvm.windows']")?.textContent).not.toContain("A thread is using");
  });

  it("puts a refused change back to the value last confirmed, says why on its own row, and keeps it through a read again", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: virtio });
    h.screen = "fit";
    render(<WinvmHost env="box" />);
    await flush();
    h.settingsWriteFail = "A thread is using the Windows VM. Stop it or take over first.";
    await pick("Picture quality", "Faster");
    await flush();
    expect(screen.getByRole("combobox", { name: "Picture quality" }).textContent).toContain("Sharp");
    const quality = document.querySelector("[data-setting='winvm.quality']")!;
    expect(quality.textContent).toContain("A thread is using the Windows VM");
    expect(document.querySelector("[data-setting='winvm.windows']")?.textContent).not.toContain("A thread is using");
    // A read again (the socket opening, a push) does not wipe the reason.
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "awake", display: virtio }) })));
    expect(document.querySelector("[data-setting='winvm.quality']")?.textContent).toContain("A thread is using the Windows VM");
  });

  it("asks for the restart only once Fits my window was saved", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: vga });
    h.settingsWriteFail = "The box refused the change.";
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Screen size", "Fits my window");
    await flush();
    expect(pressed()).toEqual([]);
    expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("1280 × 800");
    expect(document.querySelector("[data-setting='winvm.screen']")?.textContent).toContain("refused");
  });

  it("keeps Fits my window saving until the upgrade ends: saved once live resize is on, the old size back if it failed", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Screen size", "Fits my window");
    await flush();
    const mark = () => document.querySelector("[data-setting='winvm.screen'] [data-slot=save-mark]")?.getAttribute("data-state");
    expect(pressed()).toEqual(["work.winvm.display.upgrade"]);
    // The steps run: still saving, never Saved.
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "setting-up", step: "Restarting Windows", display: vga }) })));
    expect(mark()).not.toBe("saved");
    // It ends on live resize: Saved.
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "awake", display: virtio }) })));
    await flush();
    expect(mark()).toBe("saved");
    expect(h.calls.filter((c) => c.method === "work.winvm.settings" && (c.params as { screen?: string }).screen)).toEqual([{ method: "work.winvm.settings", params: { screen: "fit" } }]);
  });

  it("puts the size that stood back when the upgrade ends without live resize, saying so on Screen size", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Screen size", "Fits my window");
    await flush();
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "setting-up", step: "Starting Windows with live resize", display: vga }) })));
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "awake", error: "Windows did not start with the new display.", display: vga }) })));
    await flush();
    expect(h.calls.filter((c) => c.method === "work.winvm.settings" && (c.params as { screen?: string }).screen)).toEqual([
      { method: "work.winvm.settings", params: { screen: "fit" } },
      { method: "work.winvm.settings", params: { screen: "1280x800" } },
    ]);
    expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("1280 × 800");
    expect(document.querySelector("[data-setting='winvm.screen']")?.textContent).toContain("The box did not fit the Windows VM to your window.");
  });

  it("keeps watching an upgrade after the page closes: a late failure puts the size back, and the page opened again says so", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Screen size", "Fits my window");
    await flush();
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "setting-up", step: "Restarting Windows", display: vga }) })));
    // He leaves Settings mid-upgrade.
    cleanup();
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "awake", error: "Windows did not start with the new display.", display: vga }) })));
    await flush();
    expect(h.calls.filter((c) => c.method === "work.winvm.settings" && (c.params as { screen?: string }).screen)).toEqual([
      { method: "work.winvm.settings", params: { screen: "fit" } },
      { method: "work.winvm.settings", params: { screen: "1280x800" } },
    ]);
    h.screen = "1280x800";
    render(<WinvmHost env="box" />);
    await flush();
    expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("1280 × 800");
    expect(document.querySelector("[data-setting='winvm.screen']")?.textContent).toContain("The box did not fit the Windows VM to your window.");
  });

  it("a page opened mid-upgrade shows Screen size still saving", async () => {
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Screen size", "Fits my window");
    await flush();
    cleanup();
    render(<WinvmHost env="box" />);
    await flush();
    expect(document.querySelector("[data-setting='winvm.screen'] [data-slot=save-mark]")?.getAttribute("data-state")).toBe("slow");
  });

  it("settles as Saved when a reconnect's read finds live resize on, though it missed every step", async () => {
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Screen size", "Fits my window");
    await flush();
    const mark = () => document.querySelector("[data-setting='winvm.screen'] [data-slot=save-mark]")?.getAttribute("data-state");
    expect(mark()).toBe("slow");
    // The socket dropped through the whole upgrade; on reopen the machine reads awake on the live-resize display.
    h.state = at({ state: "awake", display: virtio });
    await act(async () => h.opens.forEach((fn) => fn()));
    await flush();
    expect(mark()).toBe("saved");
    expect(document.querySelector("[data-upgrade-note]")).toBeNull();
  });

  it("says an end it cannot confirm with Retry, which reads the machine again", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Screen size", "Fits my window");
    await flush();
    // On reopen the machine reads awake on the old display with no error and no step seen: not confirmed either way.
    await act(async () => h.opens.forEach((fn) => fn()));
    await flush();
    const line = document.querySelector("[data-upgrade-note]")!.closest("[data-slot=page-error-line]") as HTMLElement;
    expect(line.textContent).toContain("The box has not said yet whether the Windows VM fits your window.");
    h.state = at({ state: "awake", display: virtio });
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Retry" })));
    await flush();
    expect(document.querySelector("[data-upgrade-note]")).toBeNull();
    expect(document.querySelector("[data-setting='winvm.screen'] [data-slot=save-mark]")?.getAttribute("data-state")).toBe("saved");
  });

  it("says a size it could not put back on Screen size, with Retry that writes it again", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Screen size", "Fits my window");
    await flush();
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "setting-up", step: "Restarting Windows", display: vga }) })));
    // The upgrade fails, and the write back is refused too.
    h.settingsWriteFail = "The box refused the change.";
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "awake", error: "Windows did not start with the new display.", display: vga }) })));
    await flush();
    const line = document.querySelector("[data-upgrade-note]")!.closest("[data-slot=page-error-line]") as HTMLElement;
    expect(line.textContent).toContain("1280 × 800");
    expect(document.querySelector("[data-setting='winvm.screen']")?.textContent).toContain("The box did not fit the Windows VM to your window.");
    // The box still holds Fits my window: the select says so, not the size that was not put back.
    expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("Fits my window");
    h.settingsWriteFail = null;
  h.settingsWriteHold = null;
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Retry" })));
    await flush();
    expect(document.querySelector("[data-upgrade-note]")).toBeNull();
    expect(h.calls.filter((c) => c.method === "work.winvm.settings" && (c.params as { screen?: string }).screen).at(-1)).toEqual({ method: "work.winvm.settings", params: { screen: "1280x800" } });
    expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("1280 × 800");
  });

  it("holds Screen size while the upgrade runs, while its end is unconfirmed and while the old size is not back, Retry still offered", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Screen size", "Fits my window");
    await flush();
    const select = () => screen.getByRole("combobox", { name: "Screen size" }) as HTMLButtonElement;
    const held = () => select().disabled || select().getAttribute("aria-disabled") === "true" || select().hasAttribute("data-disabled");
    // Running, with the machine still awake on the old display.
    expect(held()).toBe(true);
    // Unconfirmed after a reconnect: still held, Retry there.
    await act(async () => h.opens.forEach((fn) => fn()));
    await flush();
    expect(document.querySelector("[data-upgrade-note]")).not.toBeNull();
    expect(held()).toBe(true);
    // It fails and the old size is refused: still held, Retry there.
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "setting-up", step: "Restarting Windows", display: vga }) })));
    h.settingsWriteFail = "The box refused the change.";
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "awake", error: "Windows did not start with the new display.", display: vga }) })));
    await flush();
    expect(document.querySelector("[data-upgrade-note]")?.closest("[data-slot=page-error-line]")?.textContent).toContain("1280 × 800");
    expect(held()).toBe(true);
    // The old size goes back: Screen size takes picks again.
    h.settingsWriteFail = null;
  h.settingsWriteHold = null;
    const line = document.querySelector("[data-upgrade-note]")!.closest("[data-slot=page-error-line]") as HTMLElement;
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Retry" })));
    await flush();
    expect(held()).toBe(false);
  });

  it("holds Screen size from the Fits my window confirm, before the watch starts, while its save is out", async () => {
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    // The fit's save hangs: the watch has not started yet.
    h.settingsWriteHold = new Promise(() => {});
    await pick("Screen size", "Fits my window");
    await flush();
    const select = screen.getByRole("combobox", { name: "Screen size" }) as HTMLButtonElement;
    expect(select.disabled || select.hasAttribute("data-disabled")).toBe(true);
    // A pick now is refused: no second write leaves.
    const writes = h.calls.filter((c) => c.method === "work.winvm.settings" && (c.params as { screen?: string }).screen).length;
    await act(async () => fireEvent.click(select));
    expect(screen.queryByRole("option", { name: "2560 × 1600" })).toBeNull();
    expect(h.calls.filter((c) => c.method === "work.winvm.settings" && (c.params as { screen?: string }).screen)).toHaveLength(writes);
  });

  it("marks the display values last read after a failed read again, and holds them until a fresh read", async () => {
    vi.spyOn(registry, "environment").mockImplementation((id: string) => ({ id, name: "The box" }) as never);
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    h.settingsRead = "refused";
    await act(async () => h.opens.forEach((fn) => fn()));
    await flush();
    const select = screen.getByRole("combobox", { name: "Screen size" }) as HTMLButtonElement;
    expect(document.querySelector("[data-setting='winvm.screen']")?.textContent).toContain("As last read");
    expect(select.disabled || select.hasAttribute("data-disabled")).toBe(true);
    // No upgrade can start from the size last read.
    await act(async () => fireEvent.click(select));
    expect(screen.queryByRole("option", { name: "Fits my window" })).toBeNull();
    expect(pressed()).toEqual([]);
    // A fresh read frees it.
    h.settingsRead = "answers";
    const line = document.querySelector("[data-display-failure]")!.closest("[data-slot=page-error-line]") as HTMLElement;
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Retry" })));
    await flush();
    const fresh = screen.getByRole("combobox", { name: "Screen size" }) as HTMLButtonElement;
    expect(fresh.disabled || fresh.hasAttribute("data-disabled")).toBe(false);
    expect(document.querySelector("[data-setting='winvm.screen']")?.textContent).not.toContain("As last read");
  });

  describe("one rule: a control is held while a write or read its value depends on is out", () => {
    const isHeld = (name: string) => {
      const select = screen.getByRole("combobox", { name }) as HTMLButtonElement;
      return select.disabled || select.hasAttribute("data-disabled");
    };
    const mark = (id: string) => document.querySelector(`[data-setting='${id}'] [data-slot=save-mark]`)?.getAttribute("data-state");

    it("holds Screen size while a fixed size saves, so Fits my window starts from the size confirmed", async () => {
      h.state = at({ state: "awake", display: vga });
      render(<WinvmHost env="box" />);
      await flush();
      let land: (v: unknown) => void = () => {};
      h.settingsWriteHold = new Promise((resolve) => (land = resolve));
      await pick("Screen size", "1920 × 1200");
      await flush();
      // Its own pick stays on screen, and the select takes no other until the save answers.
      expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("1920 × 1200");
      expect(isHeld("Screen size")).toBe(true);
      expect(confirmAction).not.toHaveBeenCalled();
      h.settingsWriteHold = null;
      h.screen = "1920x1200";
      await act(async () => land({ sleepAfter: "30m", screen: "1920x1200", detail: "sharp" }));
      await flush();
      expect(isHeld("Screen size")).toBe(false);
      // Now Fits my window starts from the size the box confirmed: a failure puts 1920 × 1200 back.
      h.fail["work.winvm.display.upgrade"] = "A thread is using the Windows VM. Stop it or take over first.";
      await pick("Screen size", "Fits my window");
      await flush();
      expect(h.calls.filter((c) => c.method === "work.winvm.settings" && (c.params as { screen?: string }).screen).at(-1)).toEqual({ method: "work.winvm.settings", params: { screen: "1920x1200" } });
    });

    it("holds Screen size through the Fits my window confirm with no Saving mark; Cancel frees it", async () => {
      h.state = at({ state: "awake", display: vga });
      let answer: (ok: boolean) => void = () => {};
      vi.mocked(confirmAction).mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));
      render(<WinvmHost env="box" />);
      await flush();
      await pick("Screen size", "Fits my window");
      await flush();
      expect(isHeld("Screen size")).toBe(true);
      expect(mark("winvm.screen")).not.toBe("slow");
      expect(mark("winvm.screen")).not.toBe("saving");
      await act(async () => answer(false));
      await flush();
      expect(isHeld("Screen size")).toBe(false);
      expect(pressed()).toEqual([]);
    });

    it("holds Sleeps after and Picture quality while their own saves are out, their picks on screen", async () => {
      h.state = at({ state: "awake", display: virtio });
      h.screen = "fit";
      render(<WinvmHost env="box" />);
      await flush();
      h.settingsWriteHold = new Promise(() => {});
      await pick("Sleeps after", "2 hours");
      await flush();
      expect(screen.getByRole("combobox", { name: "Sleeps after" }).textContent).toContain("2 hours");
      expect(isHeld("Sleeps after")).toBe(true);
      // A push of the machine's state meanwhile does not take the pick off screen.
      await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "awake", display: virtio }) })));
      expect(screen.getByRole("combobox", { name: "Sleeps after" }).textContent).toContain("2 hours");
      await pick("Picture quality", "Faster");
      await flush();
      expect(screen.getByRole("combobox", { name: "Picture quality" }).textContent).toContain("Faster");
      expect(isHeld("Picture quality")).toBe(true);
    });

    it("holds the selects while the reads their values come from are out again", async () => {
      h.state = at({ state: "awake", display: virtio });
      h.screen = "fit";
      render(<WinvmHost env="box" />);
      await flush();
      expect(isHeld("Screen size")).toBe(false);
      h.settingsRead = "pending";
      // The machine's state read again hangs too: Sleeps after comes from it.
      const was = h.state;
      h.state = new Promise(() => {});
      await act(async () => h.opens.forEach((fn) => fn()));
      await flush();
      expect(isHeld("Screen size")).toBe(true);
      expect(isHeld("Picture quality")).toBe(true);
      expect(isHeld("Sleeps after")).toBe(true);
      h.state = was;
    });
  });

  it("ignores a reconnect's reply that lands after the watch settled", async () => {
    h.state = at({ state: "awake", display: vga });
    render(<WinvmHost env="box" />);
    await flush();
    await pick("Screen size", "Fits my window");
    await flush();
    // A reconnect read goes out and hangs; the success push settles the watch meanwhile.
    let refuse: (err: Error) => void = () => {};
    const reads = h.state;
    h.state = new Promise((_, reject) => (refuse = reject)) as never;
    await act(async () => h.opens.forEach((fn) => fn()));
    await act(async () => h.pushes.forEach((fn) => fn({ push: "work.winvm", state: at({ state: "awake", display: virtio }) })));
    await flush();
    expect(document.querySelector("[data-setting='winvm.screen'] [data-slot=save-mark]")?.getAttribute("data-state")).toBe("saved");
    // The late reply fails: nothing comes back.
    await act(async () => refuse(new Error("The computer did not answer")));
    await flush();
    expect(document.querySelector("[data-upgrade-note]")).toBeNull();
    h.state = reads;
  });

  it("calls an upgrade done only from an end that says so, never from the display alone", () => {
    expect(upgradeWorked(at({ state: "awake", display: virtio }))).toBe(true);
    expect(upgradeWorked(at({ state: "awake", error: "Live resize did not start.", display: virtio }))).toBe(false);
    expect(upgradeWorked(at({ state: "asleep", display: virtio }))).toBe(false);
    expect(upgradeWorked(at({ state: "awake", display: vga }))).toBe(false);
  });

  it("a key that is not an admin's reads when it sleeps as words and is offered no screen size", async () => {
    testKey.current = GIVEN_KEY;
    h.state = at({ state: "awake", display: virtio });
    render(<WinvmHost env="box" />);
    await flush();
    expect(screen.queryByRole("combobox", { name: "Screen size" })).toBeNull();
    expect(screen.getByText("30 minutes")).not.toBeNull();
  });
});
