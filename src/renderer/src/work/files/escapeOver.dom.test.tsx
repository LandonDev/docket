// @vitest-environment jsdom
/** Escape closes what lies over a file's tab, then gives the file the focus (council R2-C5); else it leaves the full window. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEscapeOver } from "./escapeOver";

afterEach(cleanup);

function Tab({ full = false, leaveFull = () => undefined }: { full?: boolean; leaveFull?: () => void }) {
  const [side, setSide] = useState(true);
  const main = useRef<HTMLDivElement>(null);
  useEscapeOver({ full, onTop: side, close: () => setSide(false), leaveFull, main });
  return (
    <>
      <div ref={main} data-testid="main" tabIndex={-1} inert={side || undefined} />
      {side ? <textarea data-testid="side" /> : null}
      <div role="menu">
        <button type="button" data-testid="menu-row" />
      </div>
    </>
  );
}

describe("Escape in a file's tab", () => {
  it("closes a second file lying over the file and gives the file the focus", () => {
    const { getByTestId, queryByTestId } = render(<Tab />);
    getByTestId("side").focus();
    act(() => void fireEvent.keyDown(getByTestId("side"), { key: "Escape" }));
    expect(queryByTestId("side")).toBeNull();
    expect(document.activeElement).toBe(getByTestId("main"));
  });

  it("leaves it to a menu that holds the key, and to a press that took Escape first", () => {
    const { getByTestId } = render(<Tab />);
    act(() => void fireEvent.keyDown(getByTestId("menu-row"), { key: "Escape" }));
    const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => void getByTestId("side").dispatchEvent(taken));
    expect(getByTestId("side")).toBeTruthy();
  });

  it("closes what lies over the file first, then leaves the full window", () => {
    const leaveFull = vi.fn();
    const { getByTestId } = render(<Tab full leaveFull={leaveFull} />);
    act(() => void fireEvent.keyDown(getByTestId("side"), { key: "Escape" }));
    expect(leaveFull).not.toHaveBeenCalled();
    act(() => void fireEvent.keyDown(getByTestId("main"), { key: "Escape" }));
    expect(leaveFull).toHaveBeenCalledOnce();
  });
});
