// @vitest-environment jsdom
/** rightpanel-03 (D5): Stop asks the thread's host; a key that may not stop sees the rows with no Stop. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityRow } from "../../lib/activity";

const h = vi.hoisted(() => ({ may: true, held: null as string | null }));
vi.mock("../../lib/linkMayCore", () => ({ useLinkMay: () => h.may }));
vi.mock("../../lib/connection/degraded", () => ({ useHostHeld: () => h.held }));
vi.mock("../../lib/tcserver/store", () => ({ sessionStore: { environmentOf: () => "env_box" }, useSessionMeta: () => null, useSessionMetas: () => [] }));
vi.mock("../../lib/activity", async (original) => ({
  ...(await original<typeof import("../../lib/activity")>()),
  useActivity: () => ({
    meta: { status: "running", background: [] },
    rows: [{ key: "t1", kind: "shell", label: "bun test", since: Date.now(), stop: { type: "task", sessionId: "s1", taskId: "t1" } } as unknown as ActivityRow],
  }),
}));

import { ActivitySection } from "./ActivitySection";

afterEach(cleanup);

describe("Activity's Stop and the key", () => {
  it("draws Stop for a key that may stop, and none for one that may not", () => {
    render(<ActivitySection threadId="s1" />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    cleanup();
    h.may = false;
    render(<ActivitySection threadId="s1" />);
    expect(screen.getByText("bun test")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  // Round 2: the host away holds Stop in place, the link's words its tooltip.
  it("holds Stop while the host is away", () => {
    h.may = true;
    h.held = "The box is offline";
    render(<ActivitySection threadId="s1" />);
    const stop = screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(stop.closest("[data-held]")).not.toBeNull();
    h.held = null;
  });
});
