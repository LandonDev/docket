// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProjectRailOpen } from "./appearance";
import { useRailFold } from "./railFold";
import { shell, shellStore } from "../stores/shell";

vi.mock("./appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./appearance")>()),
  loadProjectRailWidth: () => 200,
  saveProjectRailOpen: vi.fn(),
}));

function Column({ width = 260, shown = true }: { width?: number; shown?: boolean }) {
  useRailFold(width, shown);
  return null;
}

const resizeTo = (width: number) =>
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  });

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  shellStore.setState({ projectRailOpen: true, railFolded: false });
  vi.mocked(saveProjectRailOpen).mockClear();
});
afterEach(cleanup);

describe("the rail at the least window width", () => {
  it("folds at 800 wide, writes nothing, and opens again as the window widens", () => {
    render(<Column />);
    expect(shellStore.getState().projectRailOpen).toBe(true);
    resizeTo(800);
    expect(shellStore.getState()).toMatchObject({ projectRailOpen: false, railFolded: true });
    resizeTo(1000);
    expect(shellStore.getState()).toMatchObject({ projectRailOpen: true, railFolded: false });
    expect(saveProjectRailOpen).not.toHaveBeenCalled();
  });

  it("opens folded in an 800-wide window", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    render(<Column />);
    expect(shellStore.getState()).toMatchObject({ projectRailOpen: false, railFolded: true });
  });

  it("leaves a rail he opens while cramped open, and one he closed closed", () => {
    render(<Column />);
    resizeTo(800);
    act(() => shell.toggleProjectRail());
    resizeTo(790);
    expect(shellStore.getState().projectRailOpen).toBe(true);
    act(() => shell.toggleProjectRail());
    resizeTo(1200);
    expect(shellStore.getState().projectRailOpen).toBe(false);
  });

  it("does not fold while the column is hidden", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    render(<Column shown={false} />);
    expect(shellStore.getState().projectRailOpen).toBe(true);
  });
});
