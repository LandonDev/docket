// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { AppearancePage } from "./Appearance";

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
  it("is two rows while Work is off everywhere: the theme and the editor's type size", () => {
    render(<AppearancePage />);
    expect(document.querySelectorAll("[data-slot=page-row]")).toHaveLength(2);
    expect(screen.getByRole("combobox", { name: "Theme" }).textContent).toContain("Dark");
    expect(screen.getByRole("combobox", { name: "Editor font size" }).textContent).toContain("13px");
    expect(screen.queryByRole("combobox", { name: "Work" })).toBeNull();
  });

  it("applies Light when chosen", async () => {
    render(<AppearancePage />);
    await choose("Theme", "Light");
    expect(document.documentElement.classList.contains("theme-light")).toBe(true);
    expect(localStorage.getItem("monocode.colorScheme")).toBe("light");
    expect(localStorage.getItem("monocode.colorScheme.work")).toBeNull();
  });

  it("shows a choice made in another window", async () => {
    render(<AppearancePage />);
    localStorage.setItem("monocode.colorScheme", "light");
    await act(async () => void window.dispatchEvent(new StorageEvent("storage", { key: "monocode.colorScheme" })));
    expect(screen.getByRole("combobox", { name: "Theme" }).textContent).toContain("Light");
  });

  it("saves the editor's type size", async () => {
    render(<AppearancePage />);
    await choose("Editor font size", "14px");
    expect(localStorage.getItem("monocode.editorFontSize")).toBe("14");
    expect(document.documentElement.style.getPropertyValue("--font-size-code")).toBe("14px");
  });

  describe("with Work on", () => {
    beforeEach(() => act(() => setWorkOn("local", true)));
    afterEach(() => act(() => workSwitch.reset()));

    it("is a Theme section with a row for Code and a row for Work, then the editor's type size", () => {
      render(<AppearancePage />);
      expect(screen.getByText("Theme")).toBeTruthy();
      expect([...document.querySelectorAll("[data-slot=page-row]")].map((row) => row.querySelector("[role=combobox]")?.getAttribute("aria-label"))).toEqual(["Code", "Work", "Editor font size"]);
      expect(screen.queryByRole("combobox", { name: "Theme" })).toBeNull();
      // The section's rows are its own; the editor's row sits under it, in a section of its own.
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
      expect(localStorage.getItem("monocode.colorScheme.work")).toBe("dark");
      await choose("Code", "System");
      expect(screen.getByRole("combobox", { name: "Work" }).textContent).toContain("Dark");
    });

    it("changes the window only for the kind of place it is on", async () => {
      // This window is on a code place.
      render(<AppearancePage />);
      await choose("Work", "Light");
      expect(localStorage.getItem("monocode.colorScheme.work")).toBe("light");
      expect(document.documentElement.classList.contains("theme-light")).toBe(false);
      await choose("Code", "Light");
      expect(document.documentElement.classList.contains("theme-light")).toBe(true);
    });
  });
});
