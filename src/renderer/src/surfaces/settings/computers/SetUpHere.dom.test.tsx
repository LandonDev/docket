// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComputerRow } from "@server/shared/contract-devices";

/** Set up from this Mac: what a set-up computer holds, Stop… and Remove… asking first, Start at once. */

const confirms: { title: string; body?: string }[] = [];
let answer = true;
vi.mock("../../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<typeof import("../../../chrome/ConfirmDialog")>()),
  confirmAction: async (request: { title: string; body?: string }) => {
    confirms.push(request);
    return answer;
  },
}));

const { SetUpView } = await import("./SetUpHere");

const row = (over: Partial<ComputerRow> = {}): ComputerRow => ({
  envId: "env_pc",
  name: "PURDUE-LT",
  state: "active",
  holds: [{ service: "claude", account: "a" }],
  syncedAt: 1_000,
  paused: false,
  waitingForContact: false,
  lastError: null,
  ...over,
});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

afterEach(() => {
  cleanup();
  confirms.length = 0;
  answer = true;
});

describe("Set up from this Mac", () => {
  it("says what it holds and asks before Stop and Remove", async () => {
    const acts: string[] = [];
    render(<SetUpView row={row()} onAct={async (action) => void acts.push(action)} now={61_000} />);
    expect(screen.getByText("Set up from this Mac")).toBeTruthy();
    expect(document.querySelector("[data-setting='pc.setup']")?.textContent).toContain("synced 1m ago");
    fireEvent.click(screen.getByText("Stop…"));
    await flush();
    expect(confirms[0]).toEqual(expect.objectContaining({ title: "Stop PURDUE-LT?", body: "It is signed out of every account it was given until you start it again." }));
    answer = false;
    fireEvent.click(screen.getByText("Remove…"));
    await flush();
    expect(confirms[1]).toEqual(expect.objectContaining({ title: "Remove PURDUE-LT?" }));
    expect(acts).toEqual(["stop"]);
  });

  it("starts a stopped computer at once, and offers nothing while a removal waits for it", async () => {
    const acts: string[] = [];
    render(<SetUpView row={row({ state: "stopped" })} onAct={async (action) => void acts.push(action)} />);
    fireEvent.click(screen.getByText("Start"));
    await flush();
    expect(confirms).toEqual([]);
    expect(acts).toEqual(["start"]);
    cleanup();
    render(<SetUpView row={row({ waitingForContact: true })} onAct={async () => {}} />);
    expect(screen.queryByText("Remove…")).toBeNull();
    expect(screen.getByText("Waiting for PURDUE-LT to be in touch")).toBeTruthy();
  });
});
