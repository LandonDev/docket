// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Degraded } from "../lib/connection";

let degraded: Degraded | null = null;
const retry = vi.fn();
vi.mock("../lib/connection", async (original) => ({
  ...(await original<typeof import("../lib/connection")>()),
  useEnvironmentDegraded: () => degraded,
  useEnvironmentName: () => "The box",
  registry: { retry: (id: string) => retry(id) },
}));

import { shell } from "../stores/shell";
import { ConnectionLine, useEnvironmentBlock } from "./ConnectionLine";

const status = { transport: "reconnecting", fresh: false, lastHello: null, lastError: null, nextRetryAt: null, route: null, attempts: 2 } as never;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  retry.mockReset();
});

describe("ConnectionLine", () => {
  it.each([
    ["env_box", "computer:env_box"],
    ["local", "sharing"],
  ])("opens the refused computer's own page from Pair again (%s)", (environmentId, page) => {
    degraded = { kind: "unauthorized", status: { ...(status as object), transport: "unauthorized" } as never };
    const open = vi.spyOn(shell, "openSettings").mockImplementation(() => {});
    render(<ConnectionLine environmentId={environmentId} />);
    fireEvent.click(screen.getByRole("button", { name: "Pair again" }));
    expect(open).toHaveBeenCalledWith(page);
    open.mockRestore();
  });

  it("says the link in linkWords, never the transport's own text (a dropped socket, a refused connect)", () => {
    for (const lastError of ["the socket dropped", "could not connect"]) {
      degraded = { kind: "offline", status: { ...(status as object), transport: "offline", lastError } as never };
      const { unmount } = render(<ConnectionLine environmentId="env_box" />);
      expect(screen.getByRole("status").textContent).toBe("The box is offlineRetry");
      unmount();
    }
  });

  it("spins the one Spinner while the host reconnects, with no pulse", () => {
    degraded = { kind: "reconnecting", status };
    const { container } = render(<ConnectionLine environmentId="env_box" />);
    expect(container.querySelector('[data-slot="spinner"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(container.innerHTML).not.toMatch(/animate-(pulse|spin)\b/);
  });

  it.each(["offline", "unauthorized"] as const)("keeps a still dot when the host is %s", (kind) => {
    degraded = { kind, status };
    const { container } = render(<ConnectionLine environmentId="env_box" />);
    expect(container.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(container.querySelector(".rounded-full")).not.toBeNull();
  });

  it("sits on the box row's 6px inset with its glyph on the + axis, and wraps rather than cuts", () => {
    degraded = { kind: "offline", status: { ...(status as object), transport: "offline" } as never };
    render(<ConnectionLine environmentId="env_box" />);
    const line = screen.getByRole("status");
    expect(line.className).toContain("px-1.5");
    expect(line.firstElementChild?.className).toContain("w-7");
    expect(line.querySelector(".truncate")).toBeNull();
    expect(line.textContent).toBe("The box is offlineRetry");
  });

  it("counts the seconds inside its own line, while what the composer reads holds still", () => {
    vi.useFakeTimers();
    const start = Date.now();
    degraded = { kind: "reconnecting", status: { ...(status as object), nextRetryAt: start + 5_000 } as never };
    let composerRenders = 0;
    function ComposerReads() {
      composerRenders++;
      const block = useEnvironmentBlock("env_box");
      return <p data-testid="field">{block.text}</p>;
    }
    render(
      <>
        <ComposerReads />
        <ConnectionLine environmentId="env_box" />
      </>,
    );
    expect(screen.getByRole("status").textContent).toContain("Reconnecting to the box in 5 s");
    const before = composerRenders;
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("status").textContent).toContain("Reconnecting to the box in 3 s");
    expect(screen.getByTestId("field").textContent).toBe("Reconnecting to the box…");
    expect(composerRenders).toBe(before);
  });

  it("spins Retry from its press until the link's state moves on", () => {
    degraded = { kind: "offline", status: { ...(status as object), transport: "offline" } as never };
    const { rerender } = render(<ConnectionLine environmentId="env_box" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledWith("env_box");
    const button = screen.getByRole("button", { name: "Retry" });
    expect(button.querySelector('[data-busy="true"]')).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    degraded = { kind: "connecting", status: { ...(status as object), transport: "connecting" } as never };
    rerender(<ConnectionLine environmentId="env_box" />);
    degraded = { kind: "offline", status: { ...(status as object), transport: "offline" } as never };
    rerender(<ConnectionLine environmentId="env_box" />);
    expect(screen.getByRole("button", { name: "Retry" }).querySelector('[data-busy="true"]')).toBeNull();
  });

  it("offers Pair again, not Retry, when the host is another machine than the one paired", () => {
    degraded = { kind: "offline", status: { ...(status as object), transport: "offline", lastError: "host identity changed: expected env_a, got env_b" } as never };
    render(<ConnectionLine environmentId="env_box" />);
    expect(screen.getByRole("status").textContent).toContain("The box is not the host this computer paired with");
    expect(screen.getByRole("button", { name: "Pair again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
