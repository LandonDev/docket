// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ArrowDownCircle, CircleCheck } from "./icons";
import { UpdateRow } from "./UpdateRow";

afterEach(cleanup);

const glyphOf = (container: HTMLElement) => container.querySelector("svg")!.innerHTML;
const drawn = (Icon: typeof CircleCheck) => {
  const box = document.createElement("div");
  box.innerHTML = renderToStaticMarkup(<Icon />);
  return box.querySelector("svg")!.innerHTML;
};

describe("UpdateRow", () => {
  it("a settled update wears the check, not the download glyph Update and Restart to update wear", () => {
    const updated = render(<UpdateRow state={{ kind: "updated", version: "1.0.381" }} onOpenWhatsNew={() => {}} />);
    expect(updated.container.textContent).toContain("Updated");
    expect(glyphOf(updated.container)).toBe(drawn(CircleCheck));
    expect(glyphOf(updated.container)).not.toBe(drawn(ArrowDownCircle));
    cleanup();
    const available = render(<UpdateRow state={{ kind: "available", version: "1.0.381", retry: false }} />);
    expect(glyphOf(available.container)).toBe(drawn(ArrowDownCircle));
  });
});
