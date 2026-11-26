// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/native", async (original) => ({
  ...(await original<typeof import("../../../lib/native")>()),
  thisDesktopInLine: () => "this Mac",
}));
vi.mock("../../../lib/settings/computerName", async (original) => {
  const real = await original<typeof import("../../../lib/settings/computerName")>();
  const names: Record<string, { name: string; own: boolean }> = { local: { name: "MacBook Pro", own: true }, env_box: { name: "The box", own: false } };
  return { ...real, useReadFailWords: (id: string) => (error: string) => real.readFailWords(error, names[id]) };
});

import { NO_ANSWER } from "../../../lib/connection/openRead";
import { FailuresSaidOnce, ReadFailure } from "./ReadFailure";

afterEach(cleanup);

describe("ReadFailure", () => {
  it("names the computer, says one silence once a page, and its Retry asks every read that failed with it", async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const box = vi.fn();
    render(
      <FailuresSaidOnce>
        <ReadFailure computer="local" error={NO_ANSWER} retry={first} />
        <ReadFailure computer="local" error={NO_ANSWER} retry={second} />
        <ReadFailure computer="env_box" error={NO_ANSWER} retry={box} />
      </FailuresSaidOnce>,
    );
    expect(screen.getAllByText("This Mac did not answer.")).toHaveLength(1);
    expect(screen.getAllByText("The box did not answer.")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(box).not.toHaveBeenCalled();
  });

  it("hands the line to the next failure when the first one answers", () => {
    const { rerender } = render(
      <FailuresSaidOnce>
        <ReadFailure key="a" computer="local" error={NO_ANSWER} retry={vi.fn()} />
        <ReadFailure key="b" computer="local" error="Not allowed" retry={vi.fn()} />
        <ReadFailure key="c" computer="local" error={NO_ANSWER} retry={vi.fn()} />
      </FailuresSaidOnce>,
    );
    expect(screen.getAllByText("This Mac did not answer.")).toHaveLength(1);
    expect(screen.getByText("Not allowed.")).toBeTruthy();
    rerender(
      <FailuresSaidOnce>
        <ReadFailure key="b" computer="local" error="Not allowed" retry={vi.fn()} />
        <ReadFailure key="c" computer="local" error={NO_ANSWER} retry={vi.fn()} />
      </FailuresSaidOnce>,
    );
    expect(screen.getAllByText("This Mac did not answer.")).toHaveLength(1);
  });

  it("says its own line outside a page", () => {
    render(<ReadFailure computer="env_box" error="The box is busy" retry={vi.fn()} />);
    expect(screen.getByText("The box is busy.")).toBeTruthy();
  });
});
