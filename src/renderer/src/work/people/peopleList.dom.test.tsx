// @vitest-environment jsdom
/**
 * People's list over a long day (perf pass M12): past 80 people only the rows near the screen are mounted, each saying
 * its place in the whole list; a push that answers the directory again draws only the person who changed; the
 * minute's tick draws no row whose words stand.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { DirectoryPerson } from "./model";

/** Each person's row draws its face once a draw: the count of draws by name. */
const draws = vi.hoisted(() => new Map<string, number>());
vi.mock("../mail/face", () => ({
  Face: ({ name }: { name: string }) => {
    draws.set(name, (draws.get(name) ?? 0) + 1);
    return null;
  },
}));

const { PeopleList } = await import("./PeopleView");

const person = (i: number, over: Partial<DirectoryPerson> = {}): DirectoryPerson =>
  ({ _id: `p${i}`, name: `Person ${i}`, emails: [`p${i}@example.com`], lastAt: 1_000 * i, ...over }) as DirectoryPerson;
const many = (n: number) => Array.from({ length: n }, (_, i) => person(i));

/** The view frame's body: the list's scrolling parent. */
function Frame({ rows, now }: { rows: DirectoryPerson[]; now?: number }) {
  return (
    <div style={{ overflowY: "auto", height: 600 }}>
      <PeopleList workspaceId="ws" rows={rows} faces={new Map()} {...(now !== undefined ? { now } : {})} />
    </div>
  );
}

// jsdom lays nothing out: an element's height is its inline style's, so the scroller has a window of 600px.
const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
beforeAll(() =>
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Number.parseInt(this.style.height, 10) || 0;
    },
  }),
);
afterAll(() => Object.defineProperty(HTMLElement.prototype, "offsetHeight", height));

afterEach(() => {
  cleanup();
  draws.clear();
  localStorage.clear();
});

describe("People's list", () => {
  it("with 500 people mounts at most 60 rows, each with its place in the whole list", () => {
    const view = render(<Frame rows={many(500)} />);
    const rows = view.container.querySelectorAll("[data-person-row]");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(60);
    const item = view.container.querySelector('[role="listitem"]')!;
    expect([item.getAttribute("aria-posinset"), item.getAttribute("aria-setsize")]).toEqual(["1", "500"]);
    expect(view.container.querySelector('[role="list"]')?.getAttribute("aria-label")).toBe("People");
  });

  it("draws 80 people whole, with no place marks", () => {
    const view = render(<Frame rows={many(80)} />);
    expect(view.container.querySelectorAll("[data-person-row]")).toHaveLength(80);
    expect(view.container.querySelector('[role="listitem"]')?.hasAttribute("aria-setsize")).toBe(false);
  });

  it("a push that answers the directory again draws only the person who changed", () => {
    const view = render(<Frame rows={many(500)} now={10_000_000} />);
    const before = new Map(draws);
    // A fresh answer: every object new, one person renamed.
    const next = many(500).map((p) => (p._id === "p1" ? { ...p, name: "Person 1 (Maya)" } : p));
    view.rerender(<Frame rows={next} now={10_000_000} />);
    const after = [...draws].filter(([name, n]) => n !== (before.get(name) ?? 0)).map(([name]) => name);
    expect(after).toEqual(["Person 1 (Maya)"]);
  });

  it("a minute's tick with no word change draws no row", () => {
    const rows = many(500);
    const view = render(<Frame rows={rows} now={10_000_000} />);
    const before = new Map(draws);
    // A minute later the stamps read as they did ("Jan 1" stays "Jan 1").
    act(() => view.rerender(<Frame rows={rows} now={10_060_000} />));
    expect([...draws].every(([name, n]) => n === before.get(name))).toBe(true);
  });
});
