// @vitest-environment jsdom
/** A held Frame.io post: a comment's file, time and marks then its words; a version's stack, file and size. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ACT_VIEWS } from "../acts/registry";
import { View } from "./PostActView";

afterEach(cleanup);
const show = (payload: unknown) => render(<View item={{ kind: "frameio.post", payload } as never} env="box" />);
const labels = (el: HTMLElement) => [...el.querySelectorAll("dt")].map((dt) => dt.textContent);

describe("the Frame.io post's view", () => {
  it("is the frameio pillar's own view of frameio.post", () => {
    expect(ACT_VIEWS["frameio.post"].chunk).not.toBeNull();
  });

  it("draws a comment's file, time and each mark, then its words, and no ids", () => {
    const { container } = show({ what: "comment", account: "acc", fileId: "f1", fileName: "trailer v3.mp4", text: "Cut here", clock: "0:42", pin: { x: 0.31, y: 0.62 }, shapes: [{ tool: "ellipse", cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1, color: "#ff3b30", width: 0.003 }], height: 1080, itemId: "i", noteId: "n" });
    expect(labels(container)).toEqual(["File", "At", "Pin", "Mark", "Goes as"]);
    expect(container.textContent).toContain("Cut here");
    expect(container.textContent).not.toMatch(/\bf1\b|acc/);
  });

  it("draws a version's stack, file, size and where it was, and never its path", () => {
    const { container } = show({ what: "version", account: "acc", onto: "stk_9", ontoName: "Trailer", from: "Desktop", path: "/Users/l/held/x.mp4", name: "trailer v4.mp4", size: 734003200 });
    expect(labels(container)).toEqual(["On top of", "File", "Size", "From"]);
    expect(container.textContent).not.toMatch(/stk_9|\/Users/);
  });
});
