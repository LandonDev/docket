import { describe, expect, it } from "vitest";
import { emptyBundle } from "@shared/aliaxStats";
import { fillDays, windowDays } from "./days";

const at = (day: string, hour = 15): number => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00`).getTime();

describe("windowDays", () => {
  it("is every calendar day of the 30 to the bundle's day, a quiet week included", () => {
    const days = windowDays({ ...emptyBundle(), generatedAt: at("2026-11-26"), daily: [{ day: "2026-11-02", claude: 1, codex: 0 }, { day: "2026-11-20", claude: 1, codex: 0 }] });
    expect(days).toHaveLength(30);
    expect(days[0]).toBe("2026-10-28");
    expect(days.at(-1)).toBe("2026-11-26");
    expect(days).toContain("2026-11-10");
  });

  it("reaches back past the 30 only to an older row, and crosses a month and a clock change by date", () => {
    const days = windowDays({ ...emptyBundle(), generatedAt: at("2026-11-26", 0), cacheDaily: [{ day: "2026-10-26", hit: 80 }] });
    expect(days[0]).toBe("2026-10-26");
    expect(days).toHaveLength(32);
    expect(new Set(days).size).toBe(days.length);
  });

  it("ends at the newest row when the bundle names no time, and is empty with no rows", () => {
    const days = windowDays({ ...emptyBundle(), modelDaily: [{ day: "2026-10-30", model: "m", value: 1 }] });
    expect(days.at(-1)).toBe("2026-10-30");
    expect(days[0]).toBe("2026-10-01");
    expect(windowDays(emptyBundle())).toEqual([]);
  });
});

describe("fillDays", () => {
  it("puts each row on its day and the empty row on a day with none", () => {
    const rows = fillDays(["a", "b", "c"], [{ day: "c", hit: 4 }], (day) => ({ day, hit: null as number | null }));
    expect(rows).toEqual([{ day: "a", hit: null }, { day: "b", hit: null }, { day: "c", hit: 4 }]);
  });
});
