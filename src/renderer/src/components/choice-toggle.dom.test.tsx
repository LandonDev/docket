// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChoiceToggle } from "./choice-toggle";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma", disabled: true, note: "Not here" },
];

afterEach(cleanup);

const group = () => screen.getByRole("group", { name: "Pick" });
const button = (name: string) => within(group()).getByRole("button", { name }) as HTMLButtonElement;

describe("ChoiceToggle", () => {
  it("presses the chosen option and reports another", () => {
    const onChange = vi.fn();
    render(<ChoiceToggle label="Pick" value="a" options={OPTIONS} onChange={onChange} />);
    expect(button("Alpha").getAttribute("aria-pressed")).toBe("true");
    expect(button("Beta").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button("Beta"));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("keeps the chosen option when it is pressed again", () => {
    const onChange = vi.fn();
    render(<ChoiceToggle label="Pick" value="a" options={OPTIONS} onChange={onChange} />);
    fireEvent.click(button("Alpha"));
    expect(onChange).not.toHaveBeenCalled();
    expect(button("Alpha").getAttribute("aria-pressed")).toBe("true");
  });

  it("disables a choice with a note on a wrapper, never a title=", () => {
    render(<ChoiceToggle label="Pick" value="a" options={OPTIONS} onChange={() => {}} />);
    expect(button("Gamma").disabled).toBe(true);
    expect(button("Gamma").closest("[data-choice-note]")).toBeTruthy();
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("takes its name from a row's label when given one", () => {
    render(
      <>
        <span id="row-label">Host</span>
        <ChoiceToggle label="Pick" aria-labelledby="row-label" value="a" options={OPTIONS} onChange={() => {}} />
      </>,
    );
    expect(screen.getByRole("group", { name: "Host" })).toBeTruthy();
  });

  it("fit: shrinks to the row, the chosen label whole, a long one cut, a short one capped but never shrunk", () => {
    const options = [{ value: "a", label: "Purdue Esports" }, { value: "b", label: "UnifyPlatforms" }, { value: "c", label: "Life" }];
    render(<ChoiceToggle label="Pick" fit value="a" options={options} onChange={() => {}} />);
    expect(group().className).toContain("min-w-0");
    expect(button("Purdue Esports").className).toContain("data-pressed:max-w-none");
    expect(button("UnifyPlatforms").className).toMatch(/(^| )shrink( |$)/);
    expect(button("UnifyPlatforms").querySelector("span.truncate")?.textContent).toBe("UnifyPlatforms");
    expect(button("Life").className).toContain("max-w-18");
    expect(button("Life").className).toContain("shrink-0");
  });

  it("wrap: a second line where the row is too narrow, every label whole at the one-line track's height", () => {
    render(<ChoiceToggle label="Pick" wrap value="a" options={OPTIONS} onChange={() => {}} />);
    expect(group().className).toContain("flex-wrap");
    expect(group().className).toContain("max-w-full");
    expect(group().className).toContain("min-h-8");
    expect(button("Alpha").className).toContain("h-6.5");
    expect(button("Alpha").querySelector("span.truncate")).toBeNull();
  });

  it("without fit, draws its labels as they are", () => {
    render(<ChoiceToggle label="Pick" value="a" options={OPTIONS} onChange={() => {}} />);
    expect(button("Alpha").querySelector("span.truncate")).toBeNull();
    expect(button("Alpha").className).not.toContain("max-w-18");
  });
});
