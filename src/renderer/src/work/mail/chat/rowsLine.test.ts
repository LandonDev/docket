import { describe, expect, it } from "vitest";
import { elsewhereLine } from "./RowsCard";

describe("rows the job's mail does not hold", () => {
  it("are counted in one line under the rest", () => {
    expect(elsewhereLine(1, 3)).toBe("1 other is not in this job's mail");
    expect(elsewhereLine(2, 5)).toBe("2 others are not in this job's mail");
  });
  it("say so plainly when none of the rows is the job's", () => {
    expect(elsewhereLine(1, 1)).toBe("Not in this job's mail");
    expect(elsewhereLine(3, 3)).toBe("None of these are in this job's mail");
  });
});
