// @vitest-environment jsdom
/** The Outbox's host error row: its Retry asks that host alone, busy and off while it reads. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ open: null as null | (() => void), loadHost: vi.fn(), loadOutbox: vi.fn(async () => undefined) }));
vi.mock("./store", async (original) => ({
  ...(await original<object>()),
  loadHost: (env: string) => {
    store.loadHost(env);
    return new Promise<void>((r) => (store.open = r));
  },
  loadOutbox: store.loadOutbox,
}));

const { HostRetry } = await import("./OutboxView");

afterEach(cleanup);

describe("a host that did not answer", () => {
  it("asks that host alone again, spinning and off while it reads, and is live once it answers", async () => {
    render(<HostRetry environmentId="env_mac" />);
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(store.loadHost).toHaveBeenCalledWith("env_mac");
    expect(store.loadOutbox).not.toHaveBeenCalled();
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    await act(async () => store.open!());
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(retry.querySelector("[data-busy]")).toBeNull();
  });
});
