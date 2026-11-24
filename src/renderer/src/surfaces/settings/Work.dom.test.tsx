// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  on: new Set<string>(["env_box"]),
  calls: [] as { env: string; method: string; params: unknown }[],
}));
const ENVS = [
  { id: "env_box", name: "The box" },
  { id: "local", name: "Purdue laptop" },
];

vi.mock("../../lib/connection", () => ({
  useEnvironments: () => ENVS,
  registry: {
    linkOf: (env: string) => ({
      request: async (method: string, params: { enabled: boolean }) => {
        state.calls.push({ env, method, params });
        return { enabled: params.enabled };
      },
    }),
  },
}));
vi.mock("../../lib/workSwitch", () => ({
  useWorkHosts: () => state.on,
  setWorkOn: (env: string, on: boolean) => void (on ? state.on.add(env) : state.on.delete(env)),
}));
vi.mock("../chunks", () => ({ workShellChunk: { surface: () => () => null } }));

const { WorkPage, switchLine } = await import("./Work");

afterEach(() => {
  cleanup();
  state.on = new Set(["env_box"]);
  state.calls = [];
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
