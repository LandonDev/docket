// @vitest-environment jsdom
/** A live file that did not open: his Retry keeps the failure in place, its Retry spinning, until the file comes up or fails again. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveLayer, LiveState } from "./layer";
import { LiveBody } from "./LiveBody";

afterEach(cleanup);

function fakeLayer(first: LiveState) {
  let state = first;
  const heard = new Set<() => void>();
  const set = (next: LiveState): void => {
    state = next;
    for (const fn of heard) fn();
  };
  const layer = {
    can: () => true,
    subscribe: (_key: string, fn: () => void) => (heard.add(fn), () => void heard.delete(fn)),
    state: () => state,
    show: () => undefined,
    hide: () => undefined,
    focus: () => undefined,
    retry: () => set({ stage: "start", site: null, failed: null }),
  } as unknown as LiveLayer;
  return { layer, set };
}

describe("a live file's Retry", () => {
  it("keeps the failure with Retry spinning until the file comes up, then draws nothing over it", () => {
    const host = fakeLayer({ stage: "start", site: null, failed: "It did not load (ERR_TIMED_OUT)." });
    render(<LiveBody itemId="i1" ask="https://x.sharepoint.com/a.docx" app="word" covered={false} full={false} layer={host.layer} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("It did not load (ERR_TIMED_OUT).")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    act(() => host.set({ stage: "file", site: null, failed: null }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says the new failure with Retry at rest when it fails again", () => {
    const host = fakeLayer({ stage: "start", site: null, failed: "It did not load." });
    render(<LiveBody itemId="i1" ask="https://x.sharepoint.com/a.docx" app="word" covered={false} full={false} layer={host.layer} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    act(() => host.set({ stage: "start", site: null, failed: "It did not load (ERR_FAILED)." }));
    expect(screen.getByText("It did not load (ERR_FAILED).")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
