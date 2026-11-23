// @vitest-environment jsdom
/** Present where the desktop app's windows are in reach: In a window, and which display takes the slideshow. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMenus } from "../../chrome/menuRows";
import { presentKey, PresentButton, type PresentAsk } from "./Present";
import type { ShowNative } from "./show/Show";

beforeEach(async () => {
  sessionStorage.clear();
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

const native = (displays: Awaited<ReturnType<ShowNative["displays"]>>): ShowNative => ({ displays: async () => displays, begin: async () => ({ audience: "tc-show-n1", presenter: "tc-show-n1-presenter" }), end: async () => undefined, onDisplayGone: () => () => undefined });

describe("Present on the desktop", () => {
  it("offers In a window, and no choice of display with one display", async () => {
    const asks: PresentAsk[] = [];
    render(<PresentButton native={native([{ id: 1, label: "Built-in", own: true }])} onPresent={(ask) => void asks.push(ask)} />);
    fireEvent.click(screen.getByRole("button", { name: "Ways to present" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "In a window" }));
    expect(asks).toEqual([{ from: "here", mode: "windowed" }]);
    expect(screen.queryByText("Slideshow on")).toBeNull();
  });

  it("with two displays the slideshow goes on the other one, or the one he picks, which the next press keeps", async () => {
    const asks: PresentAsk[] = [];
    const view = render(
      <PresentButton
        native={native([
          { id: 1, label: "Built-in", own: true },
          { id: 2, label: "Projector", own: false },
        ])}
        onPresent={(ask) => void asks.push(ask)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ways to present" }));
    expect(await screen.findByText("Slideshow on")).toBeTruthy();
    const projector = await screen.findByRole("menuitemcheckbox", { name: "Projector" });
    await waitFor(() => expect(projector.getAttribute("aria-checked")).toBe("true"));
    // Picking a display leaves the menu open: the next row starts the show there.
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Built-in" }));
    await waitFor(() => expect(screen.getByRole("menuitemcheckbox", { name: "Built-in" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByRole("menuitem", { name: /From the start/ }));
    expect(asks).toEqual([{ from: "start", mode: "full", display: 1 }]);
    expect(sessionStorage.getItem("tc.show.display")).toBe("1");
    view.unmount();
    // After a reload the press on Present itself still goes where he last sent the slideshow, the menu unopened.
    render(
      <PresentButton
        native={native([
          { id: 1, label: "Built-in", own: true },
          { id: 2, label: "Projector", own: false },
        ])}
        onPresent={(ask) => void asks.push(ask)}
      />,
    );
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "Present" }));
      expect(asks.at(-1)).toEqual({ from: "here", mode: "full", display: 1 });
    });
  });
});

describe("the keys that start a show", () => {
  const key = (over: Partial<Parameters<typeof presentKey>[0]>) => presentKey({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
  it("are PowerPoint's own, with Ctrl where there is no ⌘, and a clicker's F5", () => {
    expect(key({ metaKey: true })).toEqual({ from: "here", mode: "full" });
    expect(key({ ctrlKey: true })).toEqual({ from: "here", mode: "full" });
    expect(key({ metaKey: true, shiftKey: true })).toEqual({ from: "start", mode: "full" });
    expect(key({ metaKey: true, altKey: true })).toEqual({ from: "here", mode: "presenter" });
    expect(key({ key: "F5" })).toEqual({ from: "start", mode: "full" });
    expect(key({ key: "F5", shiftKey: true })).toEqual({ from: "here", mode: "full" });
    expect(key({})).toBeNull();
    expect(key({ key: "F5", metaKey: true })).toBeNull();
    expect(key({ key: "a", metaKey: true })).toBeNull();
  });
});
