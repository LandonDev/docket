// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerAppVerdict, ComputerServiceState, ComputerSettings } from "@server/shared/contract-computer";

type Handler = (params: unknown) => Promise<unknown>;
const host = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  calls: [] as [string, unknown][],
  pushes: new Set<(p: unknown) => void>(),
  service: null as ComputerServiceState | null,
  serviceListeners: new Set<() => void>(),
  openUrl: vi.fn(),
}));

const link = {
  environmentId: "local",
  connected: true,
  onOpen: () => () => {},
  onPush: (fn: (p: unknown) => void) => {
    host.pushes.add(fn);
    return () => host.pushes.delete(fn);
  },
  request: (method: string, params: unknown) => {
    host.calls.push([method, params]);
    const handler = host.handlers[method];
    return handler ? handler(params) : new Promise(() => {});
  },
};
vi.mock("../../lib/connection", () => ({ registry: { primary: () => link } }));
vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
vi.mock("../../lib/native", () => ({ openUrl: (url: string) => host.openUrl(url), thisDesktopInLine: () => "this Mac" }));
const bridge = vi.hoisted(() => ({ hosts: [] as unknown[], asked: [] as unknown[][] }));
vi.mock("../../lib/macBridge", () => ({ useMacBridgeHosts: () => bridge.hosts, refreshMacBridgeHosts: async () => bridge.hosts }));
vi.mock("../../lib/settings/computerName", () => ({ useComputerNames: () => (id: string, said?: string) => ({ name: said ?? id, own: false }) }));
vi.mock("../../lib/settings/maySheet", () => ({ openMaySheet: (...args: unknown[]) => bridge.asked.push(args) }));
vi.mock("../../lib/computerSessions", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (fn: () => void) => {
    host.serviceListeners.add(fn);
    return () => host.serviceListeners.delete(fn);
  };
  return {
    useComputerService: () => useSyncExternalStore(subscribe, () => host.service),
    setComputerService: (_id: string, s: ComputerServiceState) => {
      host.service = s;
      host.serviceListeners.forEach((fn) => fn());
    },
  };
});

const { ComputerPage: Page, appsWords } = await import("./Computer");
const { ConfirmHost } = await import("../../chrome/ConfirmDialog");
/** The page with the app's confirm host beside it, as the app mounts it. */
const ComputerPage = () => (
  <>
    <Page />
    <ConfirmHost />
  </>
);
/** Presses the confirm's verb. */
const confirmWith = async (verb: string) => {
  const dialog = await screen.findByRole("alertdialog");
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: verb })));
};

const SERVICE: ComputerServiceState = { state: "idle", restarts: 0, permissions: null };
const app = (bundleId: string, name: string | null, classes: ComputerAppVerdict["classes"] = {}): ComputerAppVerdict => ({ bundleId, name, classes, updatedAt: 1 });
const SETTINGS: ComputerSettings = { sessionIdleMs: 120_000, activeApp: "brief", keepPictures: true, videoRemote: false, apps: [app("com.apple.TextEdit", "TextEdit"), app("com.google.Chrome", "Chrome", { click: "session", type: "session" })] };
const GRANTED = { accessibility: true, screenRecording: true };
const answer = (value: unknown): Handler => async () => value;
const calls = (method: string) => host.calls.filter(([m]) => m === method);
const section = (title: string) => screen.getByRole("heading", { name: title }).closest("[data-slot=page-section]") as HTMLElement;
const firstSection = () => document.querySelectorAll<HTMLElement>("[data-slot=page-section]")[0];
const settle = () => act(async () => {});

beforeEach(() => {
  host.handlers = {
    "computer.settings.get": answer(SETTINGS),
    "computer.permissions": answer(GRANTED),
  };
  host.calls = [];
  host.pushes.clear();
  host.service = SERVICE;
  host.openUrl.mockReset();
  bridge.hosts = [];
  bridge.asked = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Settings › Computer use", () => {
  it("holds a skeleton in each section while the host is silent", () => {
    host.handlers = {};
    host.service = null;
    render(<ComputerPage />);
    expect(firstSection().querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(1);
    expect(within(section("macOS permissions")).getAllByTestId("permission-skeleton")).toHaveLength(2);
    expect(section("Apps it has learned").querySelector("[aria-busy=true]")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says a refused read with Retry, and asks again", async () => {
    let refuse = true;
    host.handlers["computer.settings.get"] = async () => {
      if (refuse) throw new Error("forbidden: computer.settings.get");
      return SETTINGS;
    };
    render(<ComputerPage />);
    await settle();
    // One failed read, one line and one Retry: the apps it also feeds wait for it.
    expect(screen.getAllByRole("alert").map((line) => line.textContent)).toEqual(["forbidden: computer.settings.get"]);
    expect(screen.queryByRole("heading", { name: "Apps it has learned" })).toBeNull();
    refuse = false;
    fireEvent.click(within(firstSection()).getByRole("button", { name: "Retry" }));
    await settle();
    expect(calls("computer.settings.get")).toHaveLength(2);
    expect(screen.getByRole("textbox", { name: "Wait after my last input, in minutes" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(section("Apps it has learned")).toBeTruthy();
  });

  it("puts Forget all… last in its section, after the apps it forgets", async () => {
    render(<ComputerPage />);
    await settle();
    const apps = section("Apps it has learned");
    const forgetAll = within(apps).getByRole("button", { name: "Forget all…" });
    const rows = apps.querySelectorAll("[data-slot=page-row]");
    expect(rows[rows.length - 1]!.compareDocumentPosition(forgetAll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(apps.querySelector("[data-slot=page-section-action], header button")).toBeNull();
  });

  it.each([
    ["up", null],
    ["off", null],
    ["idle", null],
    ["starting", null],
    ["down", "Crashed 5 times"],
    ["unavailable", "tc-computer is not built"],
  ] as const)("shows the helper's row only while it cannot run (%s)", async (state, detail) => {
    host.service = { ...SERVICE, state, reason: state === "unavailable" ? "tc-computer is not built" : undefined, permissions: state === "up" ? GRANTED : null };
    render(<ComputerPage />);
    await settle();
    const row = document.querySelector('[data-setting="computer.helper"]');
    expect(!!row).toBe(detail !== null);
    if (detail) expect(row!.querySelector("[data-slot=status-mark]")!.textContent).toContain(detail);
    expect(!!screen.queryByRole("button", { name: "Try again" })).toBe(state === "down");
  });

  it("Try again asks the host and shows the state it answers", async () => {
    host.service = { ...SERVICE, state: "down", reason: "tc-computer crashed 5 times in two minutes: x" };
    host.handlers["computer.service.retry"] = answer({ ...SERVICE, state: "up", permissions: GRANTED });
    render(<ComputerPage />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(calls("computer.service.retry")).toHaveLength(1);
    expect(document.querySelector('[data-setting="computer.helper"]')).toBeNull();
  });

  it("shows the threshold in minutes and commits milliseconds; a refusal snaps back with the host's line", async () => {
    let refuse = false;
    host.handlers["computer.settings.set"] = async (params) => {
      if (refuse) throw new Error("the host refused it");
      return { ...SETTINGS, ...(params as object) };
    };
    render(<ComputerPage />);
    await settle();
    const field = screen.getByRole("textbox", { name: "Wait after my last input, in minutes" }) as HTMLInputElement;
    expect(field.value).toBe("2");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.blur(field);
    await settle();
    expect(calls("computer.settings.set")).toEqual([["computer.settings.set", { sessionIdleMs: 300_000 }]]);
    expect(field.value).toBe("5");
    refuse = true;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.blur(field);
    await settle();
    expect(field.value).toBe("5");
    expect(screen.getByText("The host refused it")).toBeTruthy();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "61" } });
    fireEvent.blur(field);
    await settle();
    expect(calls("computer.settings.set")).toHaveLength(2);
    expect(field.value).toBe("5");
  });

  it("lists both grants, Grant… only for a missing one with why in amber, opening its pane", async () => {
    host.handlers["computer.permissions"] = answer({ accessibility: true, screenRecording: false });
    render(<ComputerPage />);
    await settle();
    const perms = section("macOS permissions");
    expect(within(perms).getByText("Granted")).toBeTruthy();
    expect(within(perms).getByText("Threads cannot see a window without it").className).toContain("text-warning");
    const grants = within(perms).getAllByRole("button", { name: "Grant…" });
    expect(grants).toHaveLength(1);
    fireEvent.click(grants[0]!);
    expect(host.openUrl).toHaveBeenCalledWith(expect.stringContaining("Privacy_ScreenCapture"));
  });

  it("polls the grants every 5 s only while one is off, and reads the service's own while it is up", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let perms = { accessibility: false, screenRecording: true };
    host.handlers["computer.permissions"] = async () => perms;
    render(<ComputerPage />);
    await settle();
    expect(calls("computer.permissions")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(calls("computer.permissions")).toHaveLength(2);
    perms = GRANTED;
    await act(async () => vi.advanceTimersByTime(5000));
    expect(calls("computer.permissions")).toHaveLength(3);
    await act(async () => vi.advanceTimersByTime(15000));
    expect(calls("computer.permissions")).toHaveLength(3);
    // the service up: its grants, live, and no asking even with one off
    act(() => {
      host.service = { ...SERVICE, state: "up", permissions: { accessibility: true, screenRecording: false } };
      host.serviceListeners.forEach((fn) => fn());
    });
    expect(within(section("macOS permissions")).getByRole("button", { name: "Grant…" })).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(15000));
    expect(calls("computer.permissions")).toHaveLength(3);
  });

  it("says a null permissions answer as one line with Retry", async () => {
    let value: unknown = null;
    host.handlers["computer.permissions"] = async () => value;
    render(<ComputerPage />);
    await settle();
    const perms = section("macOS permissions");
    expect(within(perms).getByRole("alert").textContent).toBe("Couldn't read the permissions");
    value = GRANTED;
    fireEvent.click(within(perms).getByRole("button", { name: "Retry" }));
    await settle();
    expect(within(perms).getAllByText("Granted")).toHaveLength(2);
  });

  it("lists the apps that may take the screen first, then by name, with a line only for those", async () => {
    host.handlers["computer.settings.get"] = answer({ ...SETTINGS, apps: [...SETTINGS.apps, app("dev.unnamed", null)] });
    render(<ComputerPage />);
    await settle();
    const rows = [...section("Apps it has learned").querySelectorAll<HTMLElement>("[data-slot=page-row]")];
    expect(rows.map((r) => r.querySelector("[data-slot=item-title]")!.textContent)).toEqual(["Chrome", "An app with no name", "TextEdit"]);
    expect(rows[0].textContent).toContain("May take the screen to click and type");
    expect(rows[1].querySelector("[data-slot=item-description]")).toBeNull();
    expect(rows[2].querySelector("[data-slot=item-description]")).toBeNull();
    expect(section("Apps it has learned").textContent).not.toMatch(/session|process/);
  });

  it("forgets one app and every app, Forget all only with two or more", async () => {
    host.handlers["computer.verdicts.forget"] = async (params) => {
      const { bundleId } = params as { bundleId: string | null };
      return { ...SETTINGS, apps: bundleId === null ? [] : SETTINGS.apps.filter((a) => a.bundleId !== bundleId) };
    };
    render(<ComputerPage />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Forget TextEdit" }));
    await settle();
    expect(calls("computer.verdicts.forget")).toEqual([["computer.verdicts.forget", { bundleId: "com.apple.TextEdit" }]]);
    expect(screen.queryByRole("button", { name: "Forget TextEdit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Forget all…" })).toBeNull();
    cleanup();
    host.calls = [];
    render(<ComputerPage />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Forget all…" }));
    await screen.findByRole("alertdialog");
    expect(calls("computer.verdicts.forget")).toHaveLength(0);
    await confirmWith("Forget all");
    await settle();
    expect(calls("computer.verdicts.forget")).toEqual([["computer.verdicts.forget", { bundleId: null }]]);
    expect(within(section("Apps it has learned")).getByText("No apps used yet")).toBeTruthy();
  });

  it("says no apps in the row's place", async () => {
    host.handlers["computer.settings.get"] = answer({ ...SETTINGS, apps: [] });
    render(<ComputerPage />);
    await settle();
    expect(section("Apps it has learned").querySelector("[data-slot=page-empty]")!.textContent).toBe("No apps used yet");
    expect(screen.queryByRole("button", { name: /^Forget/ })).toBeNull();
  });

  it("follows the computer-settings push", async () => {
    render(<ComputerPage />);
    await settle();
    act(() => host.pushes.forEach((fn) => fn({ push: "computer-settings", settings: { sessionIdleMs: 600_000, activeApp: "brief", keepPictures: true, videoRemote: false, apps: [app("com.apple.Notes", "Notes")] } })));
    expect((screen.getByRole("textbox", { name: "Wait after my last input, in minutes" }) as HTMLInputElement).value).toBe("10");
    expect(screen.getByRole("button", { name: "Forget Notes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Forget TextEdit" })).toBeNull();
  });
});

describe("Let my other devices watch", () => {
  const toggle = (): HTMLElement => screen.getByRole("switch", { name: "Let my other devices watch" });

  it("is one row with a switch, off unless he turned it on, after the pictures row", async () => {
    render(<ComputerPage />);
    await settle();
    const row = toggle().closest("[data-slot=page-row]") as HTMLElement;
    expect(row.querySelector("[data-slot=item-title]")?.textContent).toBe("Let my other devices watch");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(within(row).getAllByRole("switch")).toHaveLength(1);
    expect(firstSection().contains(row)).toBe(true);
    const pictures = screen.getByRole("switch", { name: "Keep pictures of each step" }).closest("[data-slot=page-row]") as HTMLElement;
    expect(pictures.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("saves the flip, follows the host's answer and its push, and slides back when the save is refused", async () => {
    host.handlers["computer.settings.set"] = async (params) => ({ ...SETTINGS, ...(params as object) });
    render(<ComputerPage />);
    await settle();
    await act(async () => fireEvent.click(toggle()));
    expect(calls("computer.settings.set").at(-1)![1]).toEqual({ videoRemote: true });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    act(() => host.pushes.forEach((fn) => fn({ push: "computer-settings", settings: { ...SETTINGS, videoRemote: false } })));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    host.handlers["computer.settings.set"] = async () => {
      throw new Error("the host is not connected");
    };
    await act(async () => fireEvent.click(toggle()));
    await settle();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("The host is not connected")).not.toBeNull();
  });
});

describe("Keep pictures of each step", () => {
  const toggle = (): HTMLElement => screen.getByRole("switch", { name: "Keep pictures of each step" });

  it("is one row with a switch that reads the setting", async () => {
    render(<ComputerPage />);
    await settle();
    const row = toggle().closest("[data-slot=page-row]") as HTMLElement;
    expect(row.querySelector("[data-slot=item-title]")?.textContent).toBe("Keep pictures of each step");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    // one control in the row, and it sits in the first section, under the two settings before it
    expect(within(row).getAllByRole("switch")).toHaveLength(1);
    expect(firstSection().contains(row)).toBe(true);
  });

  it("asks before off, since off deletes the pictures: Cancel keeps them and sends nothing", async () => {
    host.handlers["computer.settings.set"] = async (params) => ({ ...SETTINGS, ...(params as object) });
    render(<ComputerPage />);
    await settle();
    await act(async () => fireEvent.click(toggle()));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("are deleted");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
    await settle();
    expect(calls("computer.settings.set")).toHaveLength(0);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("saves the flip once confirmed, with the mark, and follows the host's answer and its push", async () => {
    host.handlers["computer.settings.set"] = async (params) => ({ ...SETTINGS, ...(params as object) });
    render(<ComputerPage />);
    await settle();
    await act(async () => fireEvent.click(toggle()));
    await confirmWith("Delete pictures");
    await settle();
    expect(calls("computer.settings.set").at(-1)![1]).toEqual({ keepPictures: false });
    expect(document.querySelector('[data-setting="computer.pictures"] [data-slot=save-mark]')?.getAttribute("data-state")).toBe("saved");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    // another window turned it back on
    act(() => host.pushes.forEach((fn) => fn({ push: "computer-settings", settings: { ...SETTINGS, keepPictures: true } })));
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("a refused save slides the switch back and says the host's line under the row", async () => {
    host.handlers["computer.settings.set"] = async () => {
      throw new Error("the host is not connected");
    };
    render(<ComputerPage />);
    await settle();
    await act(async () => fireEvent.click(toggle()));
    await confirmWith("Delete pictures");
    await settle();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(within(toggle().closest("[data-slot=page-row]") as HTMLElement).getByText("The host is not connected")).toBeTruthy();
  });

  it("reads off from a host that has it off", async () => {
    host.handlers["computer.settings.get"] = answer({ ...SETTINGS, keepPictures: false });
    render(<ComputerPage />);
    await settle();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });
});

describe("When a step needs the app in front (§26.6)", () => {
  it("reads the setting, saves a pick and says the host's refusal", async () => {
    let refuse = false;
    host.handlers["computer.settings.set"] = async (params) => {
      if (refuse) throw new Error("the host refused it");
      return { ...SETTINGS, ...(params as object) };
    };
    render(<ComputerPage />);
    await settle();
    const trigger = screen.getByRole("combobox", { name: "When a step needs an app in front" });
    expect(trigger.textContent).toContain("Bring it forward briefly");
    await choose(trigger, "Wait until I'm away");
    await settle();
    expect(calls("computer.settings.set")).toEqual([["computer.settings.set", { activeApp: "away" }]]);
    expect(trigger.textContent).toContain("Wait until I'm away");
    refuse = true;
    await choose(trigger, "Bring it forward briefly");
    await settle();
    expect(screen.getByText("The host refused it")).toBeTruthy();
  });
});

async function choose(trigger: HTMLElement, name: string) {
  await act(async () => {
    fireEvent.click(trigger);
  });
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
  });
}

describe("Who may use this Mac's apps", () => {
  const policy = (over: Record<string, unknown>) => ({ environmentId: "env_box", name: "The box", computer: false, computerLive: 0, computerUnavailable: null, ...over });

  it("says threads here always may, then each linked computer's state, opening what it may do on this Mac", async () => {
    bridge.hosts = [policy({ computer: true, computerLive: 1 }), policy({ environmentId: "env_pc", name: "PURDUE-LT" })];
    render(<ComputerPage />);
    await settle();
    const who = section("Who may use this Mac's apps");
    expect(who.querySelector('[data-setting="computer.own"]')?.textContent).toContain("Always");
    expect(who.textContent).toContain("Allowed, 1 using it now");
    expect(who.textContent).toContain("Not allowed");
    expect(who.querySelectorAll("[data-slot=open-cue]")).toHaveLength(2);
    fireEvent.click(within(who).getByRole("button", { name: "PURDUE-LT" }));
    expect(bridge.asked).toContainEqual(["env_pc"]);
  });

  it("words each state", () => {
    expect(appsWords({ computer: false, computerLive: 0, computerUnavailable: null })).toBe("Not allowed");
    expect(appsWords({ computer: true, computerLive: 0, computerUnavailable: null })).toBe("Allowed");
    expect(appsWords({ computer: true, computerLive: 0, computerUnavailable: "Screen Recording is off" })).toBe("Allowed. Screen Recording is off");
  });
});
