// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MenuBar } from "./MenuBar";

afterEach(cleanup);

describe("MenuBar from its chunk", () => {
  it("draws nothing while the bar loads, then a lone Alt opens it as before", async () => {
    const { container } = render(<MenuBar onCommand={() => {}} />);
    expect(container.querySelector('[role="menubar"]')).toBeNull();
    await waitFor(() => {
      act(() => {
        fireEvent.keyDown(window, { key: "Alt" });
        fireEvent.keyUp(window, { key: "Alt" });
      });
      expect(screen.getByRole("menubar", { name: "Menu bar" })).toBeTruthy();
    });
  });
});
