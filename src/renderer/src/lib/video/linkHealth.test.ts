import { describe, expect, it } from "vitest";
import { CLEAR_AFTER_MS, LATE_MS, LinkHealth, p95 } from "./linkHealth";

/** Frames at 60 a second from `from` for `ms`, each `late(i)` ms late. */
function feed(link: LinkHealth, from: number, ms: number, late: (i: number) => number): number {
  let i = 0;
  for (let at = from; at < from + ms; at += 16) link.frame(at, late(i++));
  return from + ms;
}

describe("the link's word", () => {
  it("stays good on an even link and on his Wi-Fi's shape (one frame in eight 60 to 100 ms late)", () => {
    const link = new LinkHealth();
    const end = feed(link, 0, 10_000, (i) => (i % 8 === 0 ? 60 + (i % 40) : 4));
    expect(link.state(end)).toBe("good");
  });

  it("turns poor once frames run 120 ms late at the 95th centile for 3 s, and not before 3 s of them", () => {
    const link = new LinkHealth();
    feed(link, 0, 2000, () => 200);
    expect(link.state(2000)).toBe("good");
    const end = feed(link, 2000, 1200, () => 200);
    expect(link.state(end)).toBe("poor");
    // a few late frames in a good second are not the 95th centile
    const other = new LinkHealth();
    expect(other.state(feed(other, 0, 5000, (i) => (i % 25 === 0 ? 300 : 5)))).toBe("good");
  });

  it("turns poor at a second slow close within a minute, not at one, nor at two a minute and more apart", () => {
    const link = new LinkHealth();
    link.slowClose(0);
    expect(link.state(1)).toBe("good");
    link.slowClose(30_000);
    expect(link.state(30_001)).toBe("poor");
    const apart = new LinkHealth();
    apart.slowClose(0);
    apart.slowClose(61_000);
    expect(apart.state(61_001)).toBe("good");
  });

  it("clears after 5 s clean, and a late frame in those 5 s starts the wait again", () => {
    const link = new LinkHealth();
    let at = feed(link, 0, 4000, () => 250);
    expect(link.state(at)).toBe("poor");
    at = feed(link, at, 3000, () => 5);
    link.frame(at, LATE_MS + 1);
    at = feed(link, at + 16, CLEAR_AFTER_MS - 100, () => 5);
    expect(link.state(at)).toBe("poor");
    at = feed(link, at, 200, () => 5);
    expect(link.state(at)).toBe("good");
  });

  it("reads the 95th centile by nearest rank", () => {
    expect(p95([])).toBe(0);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(p95([7])).toBe(7);
  });
});
