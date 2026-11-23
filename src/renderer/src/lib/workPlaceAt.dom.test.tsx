// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { shellStore, initialShellState } from "../stores/shell";
import { openWorkPlaceAt, takeWorkPlaceAt, useWorkPlaceAt } from "./workPlaceAt";

/** Opening a page above the workspaces, at a moment the page takes once. */
function Probe({ id }: { id: string }) {
  return <output>{String(useWorkPlaceAt(id))}</output>;
}

afterEach(() => {
  cleanup();
  takeWorkPlaceAt("review");
  shellStore.setState(initialShellState());
});

describe("a page above the workspaces", () => {
  it("opens over the board, at a moment its page reads until it takes it", () => {
    const { container } = render(<Probe id="review" />);
    expect(container.textContent).toBe("null");
    act(() => openWorkPlaceAt("review", 1234));
    expect(shellStore.getState().workPlace).toBe("review");
    expect(container.textContent).toBe("1234");
    act(() => takeWorkPlaceAt("review"));
    expect(container.textContent).toBe("null");
    // Opened again with no moment, the page stays where it stands.
    act(() => openWorkPlaceAt("review"));
    expect(container.textContent).toBe("null");
  });

  it("opens nothing for a page that is not one", () => {
    openWorkPlaceAt("nowhere", 5);
    expect(shellStore.getState().workPlace).toBeNull();
  });
});
