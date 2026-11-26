// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { shell, shellStore } from "../stores/shell";
import { useVisitNav } from "./useVisitNav";

let seen: { canGoBack: boolean; canGoForward: boolean } | null = null;
function Probe() {
  seen = useVisitNav();
  return null;
}

afterEach(() => {
  cleanup();
  act(() => shell.closeOverlays());
});

describe("useVisitNav", () => {
  it("lets Back leave a page or Settings before any tab history", () => {
    act(() => shell.closeOverlays());
    render(<Probe />);
    expect(seen).toEqual({ canGoBack: false, canGoForward: false });
    act(() => shell.openInbox());
    expect(seen!.canGoBack).toBe(true);
    act(() => shell.closeOverlays());
    expect(seen!.canGoBack).toBe(false);
    act(() => shell.openSettings());
    expect(shellStore.getState().settingsOpen).toBe(true);
    expect(seen!.canGoBack).toBe(true);
  });
});
