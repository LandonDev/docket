// @vitest-environment jsdom
/** An agent's held change to a Google Doc or deck: the app and account, then one block per change, parted by hairlines. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ACT_VIEWS } from "../acts/registry";
import { View } from "./EditActView";

afterEach(cleanup);
const show = (payload: unknown) => render(<View item={{ kind: "google.edit", payload } as never} env="box" />);

describe("the Google change's view", () => {
  it("is the google pillar's own view of google.edit", () => {
    expect(ACT_VIEWS["google.edit"].chunk).not.toBeNull();
  });

  it("draws each of a deck's changes as its own block, where first, and no file id, revision or shape id", () => {
    const p = { app: "slides", account: "landon@purdue.edu", fileId: "1AbC", name: "Pitch", revisionId: "r9", edits: [{ find: "2025", replace: "2026", boxes: 3, on: [2, 5] }, { shape: "t4", text: "Hi", slide: 3, was: "Hello" }, { shape: "t5", text: "", slide: 4, was: "Old" }] };
    const { container } = show(p);
    expect([...container.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["In", "Account"]);
    const blocks = [...container.querySelectorAll("[data-change]")].map((b) => [b.querySelector("p")?.textContent, b.querySelector("del")?.textContent, b.querySelector("ins")?.textContent ?? null]);
    expect(blocks).toEqual([
      ["3 places on slides 2 and 5", "Replace: 2025", "With: 2026"],
      ["Slide 3", "Replace: Hello", "With: Hi"],
      ["Slide 4", "Take out: Old", null],
    ]);
    // Parted by hairlines: every block after the first.
    expect([...container.querySelectorAll("[data-change]")].map((b) => b.className.includes("border-t"))).toEqual([false, true, true]);
    expect(container.textContent).not.toMatch(/1AbC|r9|t4/);
  });

  it("names a Doc's sentence above its change", () => {
    const p = { app: "doc", account: "a@b.edu", name: "Brief", fileId: "1x", revisionId: "r", edits: [{ find: "March", replace: "May", within: "Plans moved twice. We ship in March. Budget is tight." }] };
    const block = show(p).container.querySelector("[data-change]")!;
    expect(block.querySelector("p")!.textContent).toBe("We ship in March.");
    expect(block.querySelector("del")!.textContent).toBe("Replace: March");
  });
});
