// @vitest-environment jsdom
/**
 * A clash's line on an event's row (docs/agents/work-clashes.md "On screen"): it wraps, whole, since its end names the
 * other job and time that tell one clash from another, and its press reaches 24px though the line is 16px.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clash, ClashSide } from "@shared/work/clashes";

vi.mock("./open", () => ({ openClash: vi.fn() }));
const { ClashLines } = await import("./mark");

afterEach(cleanup);

const T0 = new Date(2026, 10, 26, 16).getTime();
const HOUR = 3_600_000;
const side = (eventId: string, sector: string, title: string, startH: number): ClashSide => ({ eventId, sector, title, startsAt: T0 + startH * HOUR, endsAt: T0 + (startH + 2) * HOUR, can: [] });
const clash: Clash = { id: "a-b", kind: "overlap", a: side("a", "purdue", "Staff meeting", 0), b: side("b", "ref", "Varsity Basketball at Maple Ridge High School", 1), minutes: 0, miles: 0, measured: true };

describe("a clash's line", () => {
  it("wraps whole, never cut, with no tip standing in for its end", () => {
    render(<ClashLines clashes={[clash]} eventId="a" environmentId="box" />);
    const line = screen.getByRole("button", { name: /^Overlaps Varsity Basketball/ });
    expect(line.className).toContain("whitespace-normal");
    expect(line.className).not.toContain("truncate");
    expect(line.querySelector(".truncate")).toBeNull();
    expect(line.getAttribute("data-slot")).not.toBe("tooltip-trigger");
  });

  it("reaches 4px past its 16px line each way", () => {
    render(<ClashLines clashes={[clash]} eventId="a" environmentId="box" />);
    const line = screen.getByRole("button", { name: /^Overlaps/ });
    expect(line.className).toContain("leading-4");
    expect(line.className).toContain("before:-inset-y-1");
  });
});
