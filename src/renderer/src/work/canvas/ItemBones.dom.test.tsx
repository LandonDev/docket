import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ItemBones, ItemSkeleton } from "./ItemBones";

afterEach(cleanup);

describe("a document item's bones", () => {
  it("are drawn by Skullet from sample words, a title's line among them, with no hand-drawn bone", () => {
    const { container } = render(<ItemSkeleton />);
    const drawing = container.querySelector("[skullet-loading]")!;
    expect(drawing).not.toBeNull();
    expect(drawing.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("draw a title known at once as it is, outside the bones, and no sample title beside it", () => {
    const { container, getByRole } = render(<ItemBones title={<h1>Run of show</h1>} />);
    const title = getByRole("heading", { name: "Run of show" });
    expect(title.closest("[skullet-loading]")).toBeNull();
    expect(container.querySelector("[skullet-loading]")!.querySelectorAll("p")).toHaveLength(1);
  });
});
