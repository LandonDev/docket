// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
import { initMotion } from "../../lib/motion";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { zoomIn, zoomReset } from "../../lib/zoom";
import { AppearancePage, TEXT_SIZES } from "./Appearance";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
});
afterEach(cleanup);

async function choose(trigger: string, option: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox", { name: trigger }));
  });
  const item = await screen.findByRole("option", { name: option });
  await act(async () => {
    fireEvent.pointerDown(item, { pointerType: "mouse" });
    fireEvent.click(item);
  });
}

describe("Appearance", () => {
  it("is one Theme row while Work is off everywhere, then Size and motion: text size, the editor's and motion", () => {
    render(<AppearancePage />);
    expect([...document.querySelectorAll("[data-slot=page-row]")].map((row) => row.getAttribute("data-setting"))).toEqual([
      "appearance.theme",
      "appearance.textSize",
      "appearance.editorSize",
      "appearance.motion",
    ]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Size and motion"]);
    expect(screen.getByRole("combobox", { name: "Theme" }).textContent).toContain("Dark");
    expect(screen.getByRole("combobox", { name: "Text size" }).textContent).toContain("100%");
    expect(screen.getByRole("combobox", { name: "Motion" }).textContent).toContain("Follow this Mac");
    expect(screen.getByRole("combobox", { name: "Editor text size" }).textContent).toContain("13px");
    expect(screen.queryByRole("combobox", { name: "Work" })).toBeNull();
  });

  it("writes the app's zoom to the key the View menu writes, 50 to 200% in tens", async () => {
    render(<AppearancePage />);
    await choose("Text size", "120%");
    expect(localStorage.getItem("docket.zoom")).toBe("1.2");
    expect(TEXT_SIZES.map((size) => size.label)).toEqual(["50%", "60%", "70%", "80%", "90%", "100%", "110%", "120%", "130%", "140%", "150%", "160%", "170%", "180%", "190%", "200%"]);
  });

  it("follows the View menu's Zoom In and Actual Size while the page is open", async () => {
    render(<AppearancePage />);
    await act(async () => {
      await zoomIn().catch(() => {});
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("combobox", { name: "Text size" }).textContent).toContain("110%");
    await act(async () => {
      await zoomReset().catch(() => {});
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("combobox", { name: "Text size" }).textContent).toContain("100%");
  });

  it("applies Light when chosen", async () => {
    render(<AppearancePage />);
    await choose("Theme", "Light");
    expect(document.documentElement.classList.contains("theme-light")).toBe(true);
    expect(localStorage.getItem("docket.colorScheme")).toBe("light");
    expect(localStorage.getItem("docket.colorScheme.work")).toBeNull();
  });

  it("shows a choice made in another window", async () => {
    render(<AppearancePage />);
    localStorage.setItem("docket.colorScheme", "light");
    await act(async () => void window.dispatchEvent(new StorageEvent("storage", { key: "docket.colorScheme" })));
    expect(screen.getByRole("combobox", { name: "Theme" }).textContent).toContain("Light");
  });

  it("sets motion for this window, and back to following the computer", async () => {
    const stop = initMotion();
    render(<AppearancePage />);
    await choose("Motion", "Reduced");
    expect(localStorage.getItem("docket.motion")).toBe("reduced");
    expect(document.documentElement.dataset.motion).toBe("reduced");
    await choose("Motion", "Full");
    expect(document.documentElement.dataset.motion).toBe("full");
    await choose("Motion", "Follow this Mac");
    expect(localStorage.getItem("docket.motion")).toBeNull();
    stop();
  });

  it("shows a motion choice made in another window", async () => {
    render(<AppearancePage />);
    localStorage.setItem("docket.motion", "full");
    await act(async () => void window.dispatchEvent(new StorageEvent("storage", { key: "docket.motion" })));
    expect(screen.getByRole("combobox", { name: "Motion" }).textContent).toContain("Full");
  });

  it("saves the editor's type size", async () => {
    render(<AppearancePage />);
    await choose("Editor text size", "14px");
    expect(localStorage.getItem("docket.editorFontSize")).toBe("14");
    expect(document.documentElement.style.getPropertyValue("--font-size-code")).toBe("14px");
  });

  describe("with Work on", () => {
    beforeEach(() => act(() => setWorkOn("local", true)));
    afterEach(() => act(() => workSwitch.reset()));

    it("is a Theme section with a row for Code and a row for Work, then Size and motion", () => {
      render(<AppearancePage />);
      expect(screen.getByText("Theme")).toBeTruthy();
      expect([...document.querySelectorAll("[data-slot=page-row]")].map((row) => row.querySelector("[role=combobox]")?.getAttribute("aria-label"))).toEqual(["Code", "Work", "Text size", "Editor text size", "Motion"]);
      expect(screen.queryByRole("combobox", { name: "Theme" })).toBeNull();
      // The section's rows are its own; the sizes and motion sit under it, in a section of their own.
      const sections = document.querySelectorAll("section");
      expect(sections).toHaveLength(2);
      expect(sections[0].querySelectorAll("[data-slot=page-row]")).toHaveLength(2);
    });

    it("shows Work following Code until Work is chosen", async () => {
      render(<AppearancePage />);
      expect(screen.getByRole("combobox", { name: "Work" }).textContent).toContain("Dark");
      await choose("Code", "Light");
      expect(screen.getByRole("combobox", { name: "Code" }).textContent).toContain("Light");
      expect(screen.getByRole("combobox", { name: "Work" }).textContent).toContain("Light");
      await choose("Work", "Dark");
      expect(localStorage.getItem("docket.colorScheme.work")).toBe("dark");
      await choose("Code", "System");
      expect(screen.getByRole("combobox", { name: "Work" }).textContent).toContain("Dark");
    });

    it("changes the window only for the kind of place it is on", async () => {
      // This window is on a code place.
      render(<AppearancePage />);
      await choose("Work", "Light");
      expect(localStorage.getItem("docket.colorScheme.work")).toBe("light");
      expect(document.documentElement.classList.contains("theme-light")).toBe(false);
      await choose("Code", "Light");
      expect(document.documentElement.classList.contains("theme-light")).toBe(true);
    });
  });
});
