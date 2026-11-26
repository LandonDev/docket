// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { suggestionsFor, TextCombobox } from "./choice-combobox-body";

const SELLERS = ["Office Depot", "Staples", "Amazon", "Amazon"];

afterEach(cleanup);

/** The field as a caller holds it: its own text, every change kept. */
function Who({ onChange = () => {}, onSubmit }: { onChange?: (text: string) => void; onSubmit?: () => void }) {
  const [who, setWho] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <TextCombobox
        label="Who"
        value={who}
        suggestions={SELLERS}
        onChange={(text) => {
          setWho(text);
          onChange(text);
        }}
      />
    </form>
  );
}

const field = () => screen.getByRole("combobox", { name: "Who" });
const rows = () => screen.queryAllByRole("option").map((option) => option.textContent);

async function type(value: string) {
  await act(async () => {
    field().focus();
    fireEvent.input(field(), { target: { value }, inputType: "insertText" });
  });
}

async function key(name: string) {
  await act(async () => {
    fireEvent.keyDown(field(), { key: name });
  });
}

describe("suggestionsFor", () => {
  it("keeps the suggestions that hold the typed words, in order, each once", () => {
    expect(suggestionsFor(SELLERS, "")).toEqual(["Office Depot", "Staples", "Amazon"]);
    expect(suggestionsFor(SELLERS, " ama")).toEqual(["Amazon"]);
    expect(suggestionsFor(SELLERS, "PLE")).toEqual(["Staples"]);
    expect(suggestionsFor(SELLERS, "zz")).toEqual([]);
  });
});

describe("TextCombobox", () => {
  it("is the field itself, in the one text field's box, at the caller's size", () => {
    render(<TextCombobox label="Who" value="Dana" suggestions={SELLERS} onChange={() => {}} size="sm" className="w-44" aria-invalid />);
    const input = field() as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.value).toBe("Dana");
    expect(input.dataset.slot).toBe("combobox-field");
    expect(input.className).toContain("focus-field");
    expect(input.className).toContain("h-7");
    expect(input.className).toContain("w-44");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps the typed text as the value and suggests the rows that hold it", async () => {
    const onChange = vi.fn();
    render(<Who onChange={onChange} />);
    await type("sta");
    expect(onChange).toHaveBeenLastCalledWith("sta");
    expect((field() as HTMLInputElement).value).toBe("sta");
    expect(rows()).toEqual(["Staples"]);
  });

  it("keeps the popup shut while nothing matches, and the words as typed", async () => {
    render(<Who />);
    await type("Dana's Diner");
    expect(rows()).toEqual([]);
    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect((field() as HTMLInputElement).value).toBe("Dana's Diner");
  });

  it("shuts the popup on Escape and keeps the text", async () => {
    render(<Who />);
    await type("o");
    expect(rows().length).toBeGreaterThan(0);
    await key("Escape");
    expect(rows()).toEqual([]);
    expect((field() as HTMLInputElement).value).toBe("o");
  });

  it("takes the highlighted row on Enter, and submits nothing", async () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    render(<Who onChange={onChange} onSubmit={onSubmit} />);
    await type("ama");
    await key("ArrowDown");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      field().dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("Amazon");
    expect((field() as HTMLInputElement).value).toBe("Amazon");
    expect(rows()).toEqual([]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves the text on Enter with no row highlighted, and lets the form's submit through", async () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    render(<Who onChange={onChange} onSubmit={onSubmit} />);
    await type("ama");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      field().dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith("ama");
    expect((field() as HTMLInputElement).value).toBe("ama");
  });

  it("takes a row pressed with the pointer", async () => {
    const onChange = vi.fn();
    render(<Who onChange={onChange} />);
    await type("off");
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Office Depot" }));
    });
    expect(onChange).toHaveBeenLastCalledWith("Office Depot");
  });

  it("takes no keys while disabled", () => {
    render(<TextCombobox label="Who" value="" suggestions={SELLERS} onChange={() => {}} disabled />);
    expect((field() as HTMLInputElement).disabled).toBe(true);
  });
});
