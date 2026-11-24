// @vitest-environment jsdom
/**
 * Council round 7 (Sol, Today 1): with two computers, the first signed out and the second silent, Today names the
 * second beside Retry. Retry must ask that computer, and the line must stay on it while the ask is out.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ reopen: vi.fn(async (_env: string, _sector: unknown) => undefined) }));

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
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  // The laptop is signed out; the box did not answer.
  useLifeosSession: (env: string) =>
    env === "env_laptop" ? { environmentId: env, sector: null, client: null, state: "signed-out" } : { environmentId: env, sector: null, client: null, state: "unreachable", unanswered: true },
  reopenLifeos: fake.reopen,
}));

const { useTodayEnv } = await import("./env");

afterEach(() => {
  cleanup();
  fake.reopen.mockClear();
});

describe("Today's LifeOS line over two computers", () => {
  it("names the second when the first is signed out and the second silent, and Retry asks the second", async () => {
    const { result } = renderHook(() => useTodayEnv());
    expect(result.current.lifeosHost).toBe("env_box");
    expect(result.current.reach).toBe("unanswered");
    await act(async () => void (await result.current.retryLifeos?.()));
    expect(fake.reopen).toHaveBeenCalledTimes(1);
    expect(fake.reopen).toHaveBeenCalledWith("env_box", null);
    // The choice holds after the press: the line still names the computer it asked.
    expect(result.current.lifeosHost).toBe("env_box");
  });
});
