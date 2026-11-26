// @vitest-environment jsdom
/**
 * agenda.css narrows work-kit's Week blocks by the shapes work-kit draws them in (a timed block is an absolute
 * button, its title wraps by `line-clamp-2`, its time is a span after the title's): a pin of work-kit that draws
 * them otherwise must fail here, not leave two overlapping events breaking their titles mid-word again.
 */
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgendaMonth, AgendaWeek, type ViewsKit, ViewsKitProvider } from "work-kit/views";
import { workTestClock } from "../testClock";

const NOW = workTestClock();
const HOUR = 3_600_000;
const kit: ViewsKit = { SectorMark: () => null, Face: () => null, openTask: () => {} };

beforeEach(() => vi.setSystemTime(NOW));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Week's narrow blocks", () => {
  it("are drawn in the shapes agenda.css names: an absolute button, a two-line title, the time after it", () => {
    const day = new Date(NOW).setHours(0, 0, 0, 0) + HOUR;
    const at = (id: string, title: string, start: number) => ({ _id: id, title, sector: "purdue" as const, location: "CoRec 2212", startsAt: day + start * HOUR, endsAt: day + (start + 2) * HOUR, allDay: false });
    const events = [at("a", "Staff sync", 30), at("b", "Varsity Basketball", 31)];
    const { container } = render(
      <ViewsKitProvider kit={kit}>
        <div className="wk-calendar">
          <AgendaWeek events={events} day={day} weekStart={0} onOpen={() => {}} onCreate={() => {}} marked={new Set(["a", "b"])} />
        </div>
      </ViewsKitProvider>,
    );
    const blocks = [...container.querySelectorAll<HTMLButtonElement>(".wk-calendar button.absolute")];
    expect(blocks.map((b) => b.textContent)).toEqual([expect.stringContaining("Staff sync"), expect.stringContaining("Varsity Basketball")]);
    for (const block of blocks) {
      // The title, two lines in a tall block, is what one line holds under 64px.
      expect(block.querySelector(".line-clamp-2")?.textContent).toMatch(/Staff sync|Varsity Basketball/);
      // The time is a span after the title's, which goes under 64px.
      const rest = [...block.querySelectorAll(":scope > span ~ span")];
      expect(rest.length).toBeGreaterThan(0);
      expect(rest.some((s) => s.querySelector(".line-clamp-2"))).toBe(false);
    }
  });

  it("are held by agenda.css: under 64px one title line cut whole, and no time line", () => {
    const css = readFileSync(join(import.meta.dirname, "agenda.css"), "utf8");
    expect(css).toMatch(/\.wk-calendar button\.absolute \{\s*container: wk-event \/ inline-size;/);
    const narrow = css.slice(css.indexOf("@container wk-event (width < 64px)"));
    expect(narrow).toMatch(/\.wk-calendar \.line-clamp-2 \{[^}]*white-space: nowrap;[^}]*\}/);
    expect(narrow).toMatch(/\.wk-calendar \.line-clamp-2 \{[^}]*overflow-wrap: normal;[^}]*\}/);
    expect(narrow).toMatch(/\.wk-calendar button\.absolute > span ~ span \{\s*display: none;/);
  });
});

describe("the Month's day numbers", () => {
  it("are a day cell's first button, the shape agenda.css names", () => {
    const day = new Date(NOW).setHours(0, 0, 0, 0);
    const { container } = render(
      <ViewsKitProvider kit={kit}>
        <div className="wk-calendar">
          <AgendaMonth events={[]} day={day} weekStart={0} onOpen={() => {}} onPickDay={() => {}} marked={new Set()} />
        </div>
      </ViewsKitProvider>,
    );
    const numbers = [...container.querySelectorAll<HTMLButtonElement>(".wk-calendar .grid-rows-6 > div > button:first-child")];
    expect(numbers).toHaveLength(42);
    expect(numbers.every((b) => /^\d{1,2}$/.test(b.textContent ?? ""))).toBe(true);
  });

  it("are held by agenda.css: each number's press reaches 24px", () => {
    const css = readFileSync(join(import.meta.dirname, "agenda.css"), "utf8");
    expect(css).toMatch(/\.wk-calendar \.grid-rows-6 > div > button:first-child \{\s*position: relative;/);
    expect(css).toMatch(/\.wk-calendar \.grid-rows-6 > div > button:first-child::before \{\s*content: "";\s*position: absolute;\s*inset: -2px -4px;/);
  });
});
