// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The box's link status: no hello yet, then a given computer's. */
const link = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let status: { lastHello: { caps: string[]; key?: unknown } | null } = { lastHello: null };
  let statuses = new Map([["env_box", status]]);
  return {
    set(next: { caps: string[]; key?: unknown } | null) {
      status = { lastHello: next };
      statuses = new Map([["env_box", status]]);
      for (const fn of listeners) fn();
    },
    subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
    status: () => status,
    statuses: () => statuses,
  };
});
vi.mock("./connection", () => ({
  registry: { statusOf: () => link.status() },
  useEnvironmentStatus: () => useSyncExternalStore(link.subscribe, link.status),
  useEnvironmentStatuses: () => useSyncExternalStore(link.subscribe, link.statuses),
}));

const { useLinkMay, useLinksMay } = await import("./linkMay");

function Probe() {
  const one = useLinkMay("env_box", "work.routines.save");
  const many = useLinksMay()("env_box", "work.outbox.ungrant");
  return <output>{`${one} ${many}`}</output>;
}

afterEach(() => {
  cleanup();
  link.set(null);
});

describe("useLinkMay", () => {
  it("hides nothing before the hello, and follows the hello once it lands", () => {
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("true true");
    act(() => link.set({ caps: ["operate", "approve", "device"], key: { id: "k" } }));
    expect(screen.getByRole("status").textContent).toBe("false false");
    act(() => link.set({ caps: ["read", "operate", "approve", "admin"], key: { id: "k" } }));
    expect(screen.getByRole("status").textContent).toBe("true true");
  });
});
