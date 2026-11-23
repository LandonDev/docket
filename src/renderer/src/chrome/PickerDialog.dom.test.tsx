// @vitest-environment jsdom
/**
 * The go-to pickers' frame and the markdown view toggle: the search field
 * names the picker and takes the keys, Escape closes; Preview and Source
 * are one bar of two toggles.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { PickerDialog } from "./PickerDialog";
import { MarkdownModeToggle } from "./MarkdownModeToggle";

afterEach(cleanup);

describe("PickerDialog", () => {
  it("is a dialog whose search field takes the keys, and Escape closes it", async () => {
    const onClose = vi.fn();
    const onQuery = vi.fn();
    const onSearchKey = vi.fn();
    await act(async () => {
      render(
        <PickerDialog label="Go to File" data-file-picker search={createRef()} query="" onQuery={onQuery} onSearchKey={onSearchKey} onClose={onClose}>
          <p>rows</p>
        </PickerDialog>,
      );
    });
    expect(screen.getByRole("dialog").hasAttribute("data-file-picker")).toBe(true);
    const field = screen.getByRole("textbox", { name: "Go to File" });
    fireEvent.change(field, { target: { value: "app" } });
    expect(onQuery).toHaveBeenCalledWith("app");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(onSearchKey).toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(field, { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("draws Go to File's field as it always was: the glyph and the input, nothing before his words and nothing at the field's end", async () => {
    await act(async () => {
      render(
        <PickerDialog label="Go to File" search={createRef()} query="" onQuery={vi.fn()} onSearchKey={vi.fn()} onClose={vi.fn()}>
          <p>rows</p>
        </PickerDialog>,
      );
    });
    const group = document.querySelector("[data-slot=input-group]")!;
    expect([...group.children].map((el) => el.getAttribute("data-slot"))).toEqual(["input-group-leading", "input"]);
    expect(document.querySelector("[data-picker-leading]")).toBeNull();
    // the frame's children, in order: its title for a reader, the field, the rule, the list
    expect([...screen.getByRole("dialog").children].map((el) => el.getAttribute("data-slot") ?? el.tagName)).toEqual(["dialog-title", "input-group", "separator", "P"]);
  });

  it("takes a word before his words and a control at the field's end when a picker has them (Work search)", async () => {
    await act(async () => {
      render(
        <PickerDialog label="Search Work" search={createRef()} query="budget" onQuery={vi.fn()} onSearchKey={vi.fn()} onClose={vi.fn()} leading="Mail" trailing={<button type="button">All jobs</button>}>
          <p>rows</p>
        </PickerDialog>,
      );
    });
    const group = document.querySelector("[data-slot=input-group]")!;
    expect([...group.children].map((el) => el.getAttribute("data-slot") ?? (el.hasAttribute("data-picker-leading") ? "picker-leading" : el.tagName))).toEqual(["input-group-leading", "picker-leading", "input", "input-group-trailing"]);
    expect(document.querySelector("[data-picker-leading]")!.textContent).toBe("Mail");
    expect(screen.getByRole("button", { name: "All jobs" })).toBeTruthy();
    // with no list named, the field is a plain field, as Go to File's is
    expect(screen.getByRole("textbox", { name: "Search Work" }).getAttribute("aria-controls")).toBeNull();
  });

  it("makes the field a combobox over the list it is told of, naming the highlighted row; and draws no rule when told there is no row", async () => {
    await act(async () => {
      render(
        <PickerDialog label="Search Work" search={createRef()} query="budget" onQuery={vi.fn()} onSearchKey={vi.fn()} onClose={vi.fn()} listId="the-list" activeId="row-2" rule={false}>
          <p>rows</p>
        </PickerDialog>,
      );
    });
    const field = screen.getByRole("combobox", { name: "Search Work" });
    expect([field.getAttribute("aria-controls"), field.getAttribute("aria-activedescendant"), field.getAttribute("aria-expanded"), field.getAttribute("aria-autocomplete")]).toEqual(["the-list", "row-2", "true", "list"]);
    expect(document.querySelector("[data-picker-rule]")).toBeNull();
  });

  it("says why it was asked to close, so a picker may take Escape for a step back first", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <PickerDialog label="Search Work" search={createRef()} query="" onQuery={vi.fn()} onSearchKey={vi.fn()} onClose={onClose}>
          <p>rows</p>
        </PickerDialog>,
      );
    });
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox", { name: "Search Work" }), { key: "Escape" }));
    expect(onClose).toHaveBeenCalledWith("escape-key");
  });

  it("runs the rule under the field to both edges of the frame", async () => {
    await act(async () => {
      render(
        <PickerDialog label="Go to File" search={createRef()} query="" onQuery={vi.fn()} onSearchKey={vi.fn()} onClose={vi.fn()}>
          <p>rows</p>
        </PickerDialog>,
      );
    });
    const rule = document.querySelector("[data-picker-rule]")!;
    expect(rule.className).toContain("-mx-1");
    // A width of its own would pin it to the content box and leave the right end short.
    expect(rule.className).toContain("data-[orientation=horizontal]:w-auto");
  });
});

describe("MarkdownModeToggle", () => {
  it("switches between Preview and Source", () => {
    const onChange = vi.fn();
    render(<MarkdownModeToggle mode="preview" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(onChange).toHaveBeenCalledWith("source");
  });

  it("appears at once, as a keystroke opened it, and keeps its exit", async () => {
    await act(async () => {
      render(
        <PickerDialog label="Go to Symbol" search={createRef()} query="" onQuery={vi.fn()} onSearchKey={vi.fn()} onClose={vi.fn()}>
          <p>rows</p>
        </PickerDialog>,
      );
    });
    const classes = screen.getByRole("dialog").className.split(/\s+/);
    // Its starting style is its resting one: no fade, no scale, no rise.
    expect(classes).toEqual(expect.arrayContaining(["starting:opacity-100", "starting:scale-100", "starting:translate-y-0", "data-ending-style:opacity-0"]));
    expect(classes).not.toContain("starting:opacity-0");
    expect(classes).not.toContain("starting:scale-95");
    expect(classes.filter((c) => c.startsWith("starting:translate-y"))).toEqual(["starting:translate-y-0"]);
    const overlay = document.querySelector("[data-slot=dialog-overlay]")!.className.split(/\s+/);
    expect(overlay).toContain("starting:opacity-100");
    expect(overlay).not.toContain("starting:opacity-0");
  });
});
