// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MenuBar, menuBarPlace } from "./MenuBar";

afterEach(() => {
  cleanup();
  delete (window as { api?: unknown }).api;
});

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

describe("where the in-app bar mounts", () => {
  it("at /ui off macOS with a browser's rows, in a Windows window with a desktop's, and nowhere the system draws the menu", () => {
    // jsdom is no Mac and has no preload: the /ui page.
    expect(menuBarPlace()).toBe("web");
    (window as { api?: unknown }).api = { platform: "win32" };
    expect(menuBarPlace()).toBe("desktop");
    (window as { api?: unknown }).api = { platform: "linux" };
    expect(menuBarPlace()).toBeNull();
    (window as { api?: unknown }).api = { platform: "darwin" };
    expect(menuBarPlace()).toBeNull();
  });
});
