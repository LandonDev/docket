// @vitest-environment jsdom
/** A list past RANK_IN_TRANSITION paths ranks on the deferred query: the render that takes the key keeps the last ranking. */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RANK_IN_TRANSITION, useRankQuery } from "./rankQuery";

function seen(size: number): string[] {
  const out: string[] = [];
  const view = renderHook(({ q }) => out.push(useRankQuery(q, size)), { initialProps: { q: "a" } });
  act(() => view.rerender({ q: "ab" }));
  return out;
}

describe("useRankQuery", () => {
  it("ranks a small list on the key itself", () => {
    const out = seen(RANK_IN_TRANSITION);
    expect(out[1]).toBe("ab");
    expect(out.at(-1)).toBe("ab");
  });

  it("ranks a large list in a transition: the key's own render keeps the last query, the next has the new one", () => {
    const out = seen(RANK_IN_TRANSITION + 1);
    expect(out[1]).toBe("a");
    expect(out.at(-1)).toBe("ab");
  });
});
