// @vitest-environment jsdom
/** Settings → Work's LifeOS row: "LifeOS did not answer" offers Retry, which asks the host again. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { resetLifeos, setLifeosStatus } from "./lifeos";
import { LifeosHostRow } from "./settings";

afterEach(() => {
  cleanup();
  resetLifeos();
  vi.restoreAllMocks();
});

describe("a host's LifeOS row", () => {
  it("shows Retry while LifeOS does not answer, and Retry asks the host for its status", async () => {
    const request = vi.fn(async () => ({ lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request, onPush: () => () => {}, onOpen: () => () => {} } as never);
    setLifeosStatus("env_box", { lifeos: { state: "unreachable", since: Date.UTC(2026, 10, 19, 14), error: "timeout" }, keys: [] });
    render(<LifeosHostRow environmentId="env_box" name="LifeOS" />);
    expect(screen.getByText(/^LifeOS did not answer/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(request).toHaveBeenCalledWith("work.lifeos.status");
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps the line and says why when Retry gets no answer either", async () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, request: vi.fn(async () => Promise.reject(new Error("The host did not answer"))), onPush: () => () => {}, onOpen: () => () => {} } as never);
    setLifeosStatus("env_box", { lifeos: { state: "unreachable", since: Date.UTC(2026, 10, 19, 14), error: "timeout" }, keys: [] });
    render(<LifeosHostRow environmentId="env_box" name="LifeOS" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.getByText(/^LifeOS did not answer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
