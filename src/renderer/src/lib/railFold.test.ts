import { describe, expect, it } from "vitest";
import { foldStep, threadCramped } from "./railFold";

describe("threadCramped", () => {
  it("is true at the least window, 800, with the default rail and column: the thread would get 340 under its 360", () => {
    expect(threadCramped({ window: 800, rail: 200, column: 260 })).toBe(true);
  });

  it("is false once the thread keeps 360, or with the column hidden", () => {
    expect(threadCramped({ window: 820, rail: 200, column: 260 })).toBe(false);
    expect(threadCramped({ window: 800, rail: 200, column: 0 })).toBe(false);
  });
});

describe("foldStep", () => {
  it("folds on the way under the floor, at boot too, and unfolds on the way back", () => {
    expect(foldStep(null, true)).toBe("fold");
    expect(foldStep(false, true)).toBe("fold");
    expect(foldStep(true, false)).toBe("unfold");
  });

  it("does nothing while the room holds, so his own press while cramped stands", () => {
    expect(foldStep(true, true)).toBeNull();
    expect(foldStep(false, false)).toBeNull();
    expect(foldStep(null, false)).toBeNull();
  });
});
