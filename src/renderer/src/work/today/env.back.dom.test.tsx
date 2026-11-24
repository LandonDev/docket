// @vitest-environment jsdom
/**
 * Council round 9 (Sol, Today 2): with two computers, the first passed over and the second down, Today stayed on the
 * second after the first came back. A passed-over computer whose status says connected again is read again, never
 * under a Retry of the computer the line names.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeosStatus } from "@shared/contract-work-lifeos";

const fake = vi.hoisted(() => ({ reopen: vi.fn(async (_env: string, _sector: unknown): Promise<void> => undefined) }));

vi.mock("../../lib/tcserver/workspaces", () => ({
  useWorkspaces: () => [
    { id: "w1", name: "Purdue Esports", environmentId: "env_laptop", sector: "purdue", kind: "work", path: "/a" },
    { id: "w2", name: "Refereeing", environmentId: "env_box", sector: "ref", kind: "work", path: "/b" },
  ],
}));
vi.mock("../../lib/workSwitch", async (original) => ({ ...(await original<object>()), useWorkHosts: () => new Set(["env_laptop", "env_box"]) }));
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  useEnvironmentStatuses: () => new Map([["env_laptop", { transport: "open" }], ["env_box", { transport: "open" }]]),
  useEnvironments: () => [],
}));
vi.mock("../shell/actions", async (original) => ({ ...(await original<object>()), workHome: () => "env_laptop" }));
vi.mock("../tasks/minute", () => ({ useMinute: () => Date.UTC(2026, 10, 24, 17) }));
vi.mock("../shell/lifeos", async (original) => {
  const real = await original<typeof import("../shell/lifeos")>();
  return {
    ...real,
    // Each computer's session follows its heard status, as the real one's fallback does: connected is on its way (no
    // client yet); the box never answers.
    useLifeosSession: (env: string) => {
      const status = real.useLifeosStatusHeard(env);
      if (env === "env_box") return { environmentId: env, sector: null, client: null, state: "unreachable", unanswered: true };
      return { environmentId: env, sector: null, client: null, state: status?.lifeos.state ?? "signed-out" };
    },
    reopenLifeos: fake.reopen,
  };
});

const { useTodayEnv } = await import("./env");
const { setLifeosStatus } = await import("../shell/lifeos");

const status = (state: LifeosStatus["lifeos"]["state"]): LifeosStatus => ({ lifeos: { state }, keys: [] }) as unknown as LifeosStatus;

afterEach(() => {
  cleanup();
  fake.reopen.mockReset();
  fake.reopen.mockImplementation(async () => undefined);
});

describe("Today's LifeOS computer, coming back", () => {
  it("reads a passed-over computer again once its status says connected while the one read now is down", () => {
    act(() => setLifeosStatus("env_laptop", status("signed-out")));
    const { result } = renderHook(() => useTodayEnv());
    expect(result.current.lifeosHost).toBe("env_box");
    expect(result.current.reach).toBe("unanswered");
    act(() => setLifeosStatus("env_laptop", status("connected")));
    expect(result.current.lifeosHost).toBe("env_laptop");
    expect(result.current.reach).toBe("waiting");
  });

  it("keeps the computer a Retry asks until the ask is back, then reads the one that came back", async () => {
    act(() => setLifeosStatus("env_laptop", status("signed-out")));
    let answer!: () => void;
    fake.reopen.mockImplementation(() => new Promise<void>((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useTodayEnv());
    expect(result.current.lifeosHost).toBe("env_box");
    let retried!: Promise<void>;
    act(() => void (retried = result.current.retryLifeos!()));
    expect(fake.reopen).toHaveBeenCalledWith("env_box", null);
    act(() => setLifeosStatus("env_laptop", status("connected")));
    // The line under his press still names the box.
    expect(result.current.lifeosHost).toBe("env_box");
    await act(async () => {
      answer();
      await retried;
    });
    expect(result.current.lifeosHost).toBe("env_laptop");
  });

  it("does not take back a computer on the status it was passed over on", () => {
    act(() => setLifeosStatus("env_laptop", status("refused")));
    const { result, rerender } = renderHook(() => useTodayEnv());
    rerender();
    expect(result.current.lifeosHost).toBe("env_box");
  });
});
