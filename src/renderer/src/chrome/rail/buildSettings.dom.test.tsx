// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildConfig } from "@server/shared/build";

const state = vi.hoisted(() => ({
  config: null as BuildConfig | null | "pending" | "refused",
  detected: { command: "bun run build", outputs: "out/**" } as BuildConfig | null,
  set: vi.fn(),
  failSet: false,
  /** build.set answers wait for the test to let them go, in order. */
  hold: false,
  held: [] as (() => void)[],
}));

vi.mock("../../lib/tcserver/workspaces", () => ({
  useWorkspaces: () => [{ id: "w1", name: "Alpha", path: "/w/alpha", environmentId: "local" }],
}));
vi.mock("../../lib/connection", () => {
  const link = {
    connected: true,
    onOpen: () => () => {},
    request: (method: string, params: unknown) => {
        if (method === "build.get")
          return state.config === "pending"
            ? new Promise(() => {})
            : state.config === "refused"
              ? Promise.reject(new Error("The host did not answer"))
              : Promise.resolve(state.config);
        if (method === "build.detect") return Promise.resolve(state.detected);
        state.set(method, params);
        if (state.hold) return new Promise((done) => state.held.push(() => done(null)));
        return state.failSet ? Promise.reject(new Error("build.set refused")) : Promise.resolve(null);
      },
  };
  return { registry: { linkOf: () => link } };
});

vi.mock("../../lib/linkMay", () => ({ useLinkMay: () => true }));
vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));

const { BuildEditor, openBuildSettings, takeRequestedBuildFocus } = await import("./buildSettings");
const { OPEN_SETTINGS_EVENT } = await import("../../lib/monaco/debugTab");

beforeEach(() => {
  state.config = null;
  state.failSet = false;
  state.hold = false;
  state.held = [];
  state.set.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("BuildEditor", () => {
  it("shows skeleton rows before build.get answers", () => {
    state.config = "pending";
    render(<BuildEditor workspaceId="w1" />);
    expect(screen.getByTestId("build-skeleton")).toBeTruthy();
  });

  it("draws no field when build.get fails, so nothing typed can save over the real config: the error and Retry", async () => {
    state.config = "refused";
    render(<BuildEditor workspaceId="w1" />);
    const section = await screen.findByRole("region", { name: "Build" });
    await act(async () => {});
    expect(section.querySelector("input")).toBeNull();
    expect(section.querySelector("[role=alert]")?.textContent).toBe("The host did not answer");
    state.config = { command: "make", outputs: "" } as BuildConfig;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(((await screen.findByRole("textbox", { name: "Build command" })) as HTMLInputElement).value).toBe("make");
    expect(state.set).not.toHaveBeenCalled();
  });

  it("shows the detected command as the placeholder", async () => {
    render(<BuildEditor workspaceId="w1" />);
    const command = (await screen.findByRole("textbox", { name: "Build command" })) as HTMLInputElement;
    expect(command.placeholder).toBe("bun run build");
    expect(command.closest("[data-slot=page-row]")).toBeTruthy();
  });

  it("saves the trimmed config once, on Enter, and not while typing", async () => {
    render(<BuildEditor workspaceId="w1" />);
    const command = await screen.findByRole("textbox", { name: "Build command" });
    act(() => (command as HTMLInputElement).focus());
    fireEvent.change(command, { target: { value: " make" } });
    fireEvent.change(command, { target: { value: " make all " } });
    expect(state.set).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(command, { key: "Enter" }));
    expect(state.set).toHaveBeenCalledTimes(1);
    expect(state.set).toHaveBeenCalledWith("build.set", { workspaceId: "w1", config: { command: "make all", outputs: "" } });
  });
});

describe("BuildEditor writes", () => {
  it("queues two quick edits against the last confirmed set, so the second keeps the first", async () => {
    state.config = { command: "", outputs: "" } as BuildConfig;
    state.hold = true;
    render(<BuildEditor workspaceId="w1" />);
    const command = (await screen.findByRole("textbox", { name: "Build command" })) as HTMLInputElement;
    const makes = screen.getByRole("textbox", { name: "What it makes" }) as HTMLInputElement;
    act(() => command.focus());
    fireEvent.change(command, { target: { value: "make" } });
    await act(async () => fireEvent.keyDown(command, { key: "Enter" }));
    act(() => makes.focus());
    fireEvent.change(makes, { target: { value: "dist/**" } });
    await act(async () => fireEvent.keyDown(makes, { key: "Enter" }));
    // The second waits for the first.
    expect(state.set).toHaveBeenCalledTimes(1);
    await act(async () => state.held.shift()!());
    expect(state.set).toHaveBeenCalledTimes(2);
    expect(state.set).toHaveBeenLastCalledWith("build.set", { workspaceId: "w1", config: { command: "make", outputs: "dist/**" } });
    await act(async () => state.held.shift()!());
  });

  it("waits in the loaded rows' wide shape", () => {
    state.config = "pending";
    render(<BuildEditor workspaceId="w1" />);
    const bones = screen.getByTestId("build-skeleton").querySelectorAll("[data-slot=page-row-skeleton]");
    expect(bones).toHaveLength(2);
    for (const bone of bones) expect(bone.className).toContain("@max-[30rem]/page:flex-wrap");
  });
});

describe("BuildEditor errors", () => {
  it("snaps a refused value back and says why under its row", async () => {
    state.failSet = true;
    render(<BuildEditor workspaceId="w1" />);
    const command = (await screen.findByRole("textbox", { name: "Build command" })) as HTMLInputElement;
    act(() => command.focus());
    fireEvent.change(command, { target: { value: "make" } });
    await act(async () => fireEvent.keyDown(command, { key: "Enter" }));
    expect((await screen.findByText("Build.set refused")).className).toContain("text-destructive");
    expect(command.value).toBe("");
  });
});

describe("openBuildSettings", () => {
  it("opens the workspace's page and asks for the Build section once", () => {
    const seen: string[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, listen);
    openBuildSettings("w1");
    window.removeEventListener(OPEN_SETTINGS_EVENT, listen);
    expect(seen).toEqual(["ws:w1"]);
    expect(takeRequestedBuildFocus()).toBe(true);
    expect(takeRequestedBuildFocus()).toBe(false);
  });
});
