// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  /** hosts this window's key cannot switch */
  cannot: new Set<string>(),
  on: new Set<string>(["env_box"]),
  calls: [] as { env: string; method: string; params: unknown }[],
  refuse: new Set<string>(),
}));
const ENVS = [
  { id: "env_box", name: "The box" },
  { id: "local", name: "Purdue laptop" },
];

vi.mock("../../lib/connection", () => ({
  useEnvironments: () => ENVS,
  registry: {
    environment: (id: string) => ENVS.find((e) => e.id === id),
    linkOf: (env: string) => ({
      request: async (method: string, params: { enabled: boolean }) => {
        state.calls.push({ env, method, params });
        if (state.refuse.has(env)) throw new Error("work.set: write failed (EIO)");
        return { enabled: params.enabled };
      },
    }),
  },
}));
vi.mock("../../lib/linkMay", () => ({ linkMay: (env: string) => !state.cannot.has(env) }));
vi.mock("../../lib/workSwitch", () => ({
  useWorkHosts: () => state.on,
  setWorkOn: (env: string, on: boolean) => void (on ? state.on.add(env) : state.on.delete(env)),
}));
vi.mock("../chunks", () => ({ workShellChunk: { surface: () => () => null } }));

const { WorkPage, elsewhereLine, switchLine } = await import("./Work");

afterEach(() => {
  cleanup();
  state.on = new Set(["env_box"]);
  state.cannot = new Set();
  state.calls = [];
  state.refuse = new Set();
});

describe("Settings → Work's switch", () => {
  it("turns Work on for the hosts left off alone, never off for the box", async () => {
    render(<WorkPage />);
    expect(screen.getByText(switchLine(ENVS, new Set(["env_box"]))!)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn on for Purdue laptop" })));
    expect(state.calls).toEqual([{ env: "local", method: "work.set", params: { enabled: true } }]);
    // Every host on now: the press goes, and the switch still reads on.
    expect(screen.queryByRole("button", { name: /^Turn on for/ })).toBeNull();
  });

  it("never writes to a host this window's key cannot switch, and says where that one is changed", async () => {
    // His laptop after a setup link: its key may not switch the box, which is off; the laptop itself is on.
    state.cannot = new Set(["env_box"]);
    state.on = new Set(["local"]);
    render(<WorkPage />);
    expect(screen.getByText(elsewhereLine(["The box"])!)).toBeTruthy();
    // No press offers to turn it on for the box: it would end in a refusal.
    expect(screen.queryByRole("button", { name: /^Turn on for/ })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Work" })));
    expect(state.calls).toEqual([{ env: "local", method: "work.set", params: { enabled: false } }]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("draws no switch for a key that may switch no host, and keeps the line that says where", () => {
    state.cannot = new Set(["env_box", "local"]);
    render(<WorkPage />);
    expect(screen.queryByRole("switch", { name: "Work" })).toBeNull();
    expect(screen.getByText("Work for the box and Purdue laptop is changed from a computer that manages them")).toBeTruthy();
  });

  it("says a host that did not take the switch in a sentence naming it, never the link's text", async () => {
    state.on = new Set(["env_box", "local"]);
    state.refuse = new Set(["local"]);
    render(<WorkPage />);
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Work" })));
    expect(screen.getByRole("alert").textContent).toBe("Purdue laptop did not save the change.");
  });

  it("offers no such press while every host agrees", () => {
    state.on = new Set(["env_box", "local"]);
    render(<WorkPage />);
    expect(screen.queryByRole("button", { name: /^Turn on for/ })).toBeNull();
    cleanup();
    state.on = new Set();
    render(<WorkPage />);
    expect(screen.queryByRole("button", { name: /^Turn on for/ })).toBeNull();
  });
});
