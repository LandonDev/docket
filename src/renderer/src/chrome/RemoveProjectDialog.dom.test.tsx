// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let resolveCount: (n: number) => void = () => {};
vi.mock("../lib/projectData", () => ({
  projectSessionCount: () => new Promise<number>((resolve) => (resolveCount = resolve)),
}));

import { RemoveProjectDialog, removeProjectNote } from "./RemoveProjectDialog";

afterEach(cleanup);

describe("RemoveProjectDialog", () => {
  it("is an alert that says what stays, holds Remove and the count's line until the count lands, then says what goes", async () => {
    const onConfirm = vi.fn();
    const onDone = vi.fn();
    render(<RemoveProjectDialog name="Alpha" path="/x/alpha" onCancel={() => {}} onConfirm={onConfirm} onDone={onDone} />);
    const alert = screen.getByRole("alertdialog");
    expect(screen.getByText("Remove “Alpha”?")).toBeTruthy();
    expect(alert.textContent).toContain("Files on disk stay.");
    // Counting: a bone in the count's line, and Remove spins, not pressable.
    expect(alert.querySelector("[data-confirm-note] [data-remove-count]")).toBeTruthy();
    const verb = screen.getAllByRole("button").find((b) => b.textContent?.includes("Remove"))!;
    expect(verb.hasAttribute("disabled") || verb.getAttribute("aria-disabled") === "true").toBe(true);
    fireEvent.click(verb);
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => resolveCount(12));
    expect(alert.querySelector("[data-remove-count]")).toBeNull();
    expect(alert.querySelector("[data-confirm-note]")!.textContent).toBe("Its 12 threads are deleted.");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // The parent clears its state only once the exit has played.
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("words one thread and none", () => {
    expect(removeProjectNote(1)).toBe("Its thread is deleted.");
    expect(removeProjectNote(0)).toBe("It has no threads.");
    expect(removeProjectNote(4)).toBe("Its 4 threads are deleted.");
  });
});
