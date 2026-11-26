// @vitest-environment jsdom
/** edges-38: the grace counts from when the link left open, so a draft that mounts on a host away for a while says so at once. */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "./registry";
import { IDLE_STATUS, type EnvironmentStatus } from "./types";
import { DEGRADED_GRACE_MS, useEnvironmentDegraded } from "./degraded";

const listeners = new Set<() => void>();
let status: EnvironmentStatus = { ...IDLE_STATUS, transport: "open" };
vi.spyOn(registry, "statusOf").mockImplementation(() => status);
vi.spyOn(registry, "statuses").mockImplementation(() => new Map([["env_box", status]]));
vi.spyOn(registry, "subscribe").mockImplementation((listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
});
const set = (next: EnvironmentStatus) => act(() => {
  status = next;
  for (const listener of [...listeners]) listener();
});

function Probe({ label }: { label: string }) {
  const degraded = useEnvironmentDegraded("env_box");
  return <p data-testid={label}>{degraded?.kind ?? "open"}</p>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useEnvironmentDegraded", () => {
  it("holds a fresh drop inside the grace, then says it", () => {
    vi.useFakeTimers();
    render(<Probe label="a" />);
    set({ ...IDLE_STATUS, transport: "reconnecting" });
    expect(screen.getByTestId("a").textContent).toBe("open");
    act(() => vi.advanceTimersByTime(DEGRADED_GRACE_MS + 5));
    expect(screen.getByTestId("a").textContent).toBe("reconnecting");
    set({ ...IDLE_STATUS, transport: "open" });
  });

  it("says it at once in a control that mounts after the host has been away past the grace", () => {
    vi.useFakeTimers();
    const first = render(<Probe label="a" />);
    set({ ...IDLE_STATUS, transport: "reconnecting" });
    act(() => vi.advanceTimersByTime(9_000));
    first.unmount();
    render(<Probe label="draft" />);
    expect(screen.getByTestId("draft").textContent).toBe("reconnecting");
  });
});
