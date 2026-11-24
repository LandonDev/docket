// @vitest-environment jsdom
/** Owed and Messages over midnight: the same host answers, said from the new day, with no push. */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodayEnv, TodayWorkspace } from "./types";

const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();
const ws: TodayWorkspace = { environmentId: "box", workspaceId: "w1", sector: "ref", name: "Ref", path: "/w", open: true };
const owed = { workspace: ws, value: { rows: [{ workspaceId: "w1", sector: "ref", row: 4, who: "West Side HS", what: "", amount: 8000, since: "2026-11-23", way: "toHim", reimburse: false, both: false }], toConfirm: 0 } };
const chats = { workspace: ws, value: { rows: [{ chatId: "c1", chat: "Dana Lee", who: "Dana Lee", text: "Can you look?", at: at(23, 14), source: "slack" }] } };
// One read, the same object on every render: nothing but the day moves.
const reads = vi.hoisted(() => ({ answers: [] as unknown[] }));
vi.mock("./read", async (original) => {
  const snap = { answers: reads.answers, loading: false, failed: [], stale: false, away: false };
  return { ...(await original<object>()), useEachWorkspace: () => snap };
});

const { source: money } = await import("../money/today");
const { source: messages } = await import("../messages/today");

const envOn = (day: number): TodayEnv => ({ day: { from: at(day, 0), to: at(day + 1, 0) }, workspaces: [ws], lifeos: { environmentId: "box", sector: null, client: null, state: "connected" } as never, workspaceOf: () => ws });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  reads.answers.length = 0;
});

describe("over midnight", () => {
  it("Owed says how long from the new day", () => {
    reads.answers.push(owed);
    vi.useFakeTimers({ now: at(23, 23), toFake: ["Date"] });
    const { result, rerender } = renderHook(({ env }) => money.use(env), { initialProps: { env: envOn(23) } });
    const before = result.current.rows![0]!.when;
    vi.setSystemTime(at(24, 0) + 60_000);
    rerender({ env: envOn(24) });
    expect(result.current.rows![0]!.when).not.toBe(before);
  });

  it("Messages says a time from the new day", () => {
    reads.answers.push(chats);
    vi.useFakeTimers({ now: at(23, 23), toFake: ["Date"] });
    const { result, rerender } = renderHook(({ env }) => messages.use(env), { initialProps: { env: envOn(23) } });
    expect(result.current.rows![0]!.when).toBe("2:00 PM");
    vi.setSystemTime(at(24, 0) + 60_000);
    rerender({ env: envOn(24) });
    expect(result.current.rows![0]!.when).not.toBe("2:00 PM");
  });
});
