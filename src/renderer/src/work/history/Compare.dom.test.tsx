// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { diffBlocks } from "work-kit/formats/diff";
import { paraText } from "work-kit/editor/para";
import { CompareDoc } from "./Compare";

afterEach(cleanup);

const text = (value: string, styles: Record<string, unknown> = {}) => ({ type: "text", text: value, styles });
const block = (id: string, type: string, props: Record<string, unknown>, ...content: unknown[]) => ({ id, type, props, content, children: [] });

/** A compare says what a change did beside the words (docs/agents/work-history.md). */
describe("a formatting change in a compare", () => {
  const before = [block("h", "heading", { level: 1 }, text("Costs")), block("a", "paragraph", {}, text("Doors open at 8:00", { fontSize: "11" })), block("b", "paragraph", {}, text("Plain line"))];
  const after = [
    block("h", "paragraph", { para: paraText({ style: "Title" }) }, text("Costs")),
    block("a", "paragraph", { para: paraText({ lineSpacing: 2 }) }, text("Doors open at 8:00", { fontSize: "14", fontFamily: "Cambria" })),
    block("b", "paragraph", {}, text("Plain line, with more")),
  ];
  const diff = diffBlocks(before, after);

  it("is said in words under its block, in one column and once, on the newer side, side by side", () => {
    const one = render(<CompareDoc diff={diff} layout="one" current={0} title="Budget" />);
    const said = [...one.container.querySelectorAll("[data-format-words]")].map((el) => el.textContent);
    expect(said).toEqual(["Heading 1 becomes Title", "Line spacing set to 2 · Font set to Cambria · 11 pt becomes 14 pt"]);
    cleanup();
    const two = render(<CompareDoc diff={diff} layout="two" current={0} title="Budget" />);
    expect([...two.container.querySelectorAll("[data-format-words]")].map((el) => el.textContent)).toEqual(said);
  });

  it("says nothing under a block whose words alone changed", () => {
    const view = render(<CompareDoc diff={diffBlocks([before[2]!], [after[2]!])} layout="one" current={0} title="Budget" />);
    expect(view.container.querySelector("[data-format-words]")).toBeNull();
  });
});
