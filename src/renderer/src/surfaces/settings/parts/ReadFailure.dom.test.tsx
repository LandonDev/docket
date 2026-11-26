// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/native", async (original) => ({
  ...(await original<typeof import("../../../lib/native")>()),
  thisDesktopInLine: () => "this Mac",
}));
vi.mock("../../../lib/settings/computerName", async (original) => {
  const real = await original<typeof import("../../../lib/settings/computerName")>();
  const names: Record<string, { name: string; own: boolean }> = {
    local: { name: "MacBook Pro", own: true },
    env_box: { name: "The box", own: false },
    env_pc: { name: "PURDUE-LT", own: false },
  };
  return { ...real, useComputerName: (id: string) => names[id], useReadFailWords: (id: string) => (error: string) => real.readFailWords(error, names[id]) };
});

import { NO_ANSWER } from "../../../lib/connection/openRead";
import { FailuresSaidOnce, ReadFailure } from "./ReadFailure";

afterEach(cleanup);

const lines = () => [...document.querySelectorAll("[data-read-failure]")].map((line) => line.textContent?.replace(/Retry$/, ""));

describe("ReadFailure", () => {
  it("says at the page's head, once, every computer that did not answer, and its Retry asks every read it stands for", async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const box = vi.fn();
    const refused = vi.fn();
    render(
      <FailuresSaidOnce>
        <section data-testid="general">
          <ReadFailure computer="local" error={NO_ANSWER} retry={first} />
        </section>
        <ReadFailure computer="local" error={NO_ANSWER} retry={second} />
        <ReadFailure computer="env_box" error={NO_ANSWER} retry={box} />
        <ReadFailure computer="env_pc" error="not allowed" retry={refused} />
      </FailuresSaidOnce>,
    );
    expect(lines()).toEqual(["This Mac and the box did not answer.", "Not allowed."]);
    // Nothing is drawn in the section's place: its heading can hide.
    expect(screen.getByTestId("general").childElementCount).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(box).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it("names three computers in one sentence, and drops one once it answers", () => {
    const page = (ids: string[]) => (
      <FailuresSaidOnce>
        {ids.map((id) => (
          <ReadFailure key={id} computer={id} error={NO_ANSWER} retry={vi.fn()} />
        ))}
      </FailuresSaidOnce>
    );
    const { rerender } = render(page(["env_box", "local", "env_pc"]));
    expect(lines()).toEqual(["The box, this Mac and PURDUE-LT did not answer."]);
    rerender(page(["env_box", "env_pc"]));
    expect(lines()).toEqual(["The box and PURDUE-LT did not answer."]);
    rerender(page([]));
    expect(lines()).toEqual([]);
  });

  it("says its own line where it stands outside a page", () => {
    render(<ReadFailure computer="env_box" error="The box is busy" retry={vi.fn()} />);
    expect(screen.getByText("The box is busy.")).toBeTruthy();
  });
});
