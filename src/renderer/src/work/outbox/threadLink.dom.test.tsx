// @vitest-environment jsdom
/**
 * The live walk (S9): the held item's "from <thread>" press was its 16px line, under the 24px every press keeps. It
 * stays a link in its line of facts and takes a hit area 4px over and under the words (an `::after`), as the house's
 * other links in a line of facts do; the request card's twin is the same.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../lib/threadMentions", async (original) => ({ ...(await original<object>()), storeTitleOf: (id: string) => (id === "t1" ? "Spring LAN draft thread" : undefined) }));

const { DetailFacts } = await import("./HeldDetail");

afterEach(cleanup);

it("the held item's thread is a press 24px tall over its 16px line, and opens the thread", () => {
  const opened = vi.fn();
  const item = { sessionId: "t1", environmentId: "box", routineRunId: null } as never;
  render(<DetailFacts item={item} job="Purdue Esports" when="8:08 AM" onOpenSession={opened} />);
  const link = screen.getByRole("button", { name: "Spring LAN draft thread" });
  expect(link.className).toContain("relative");
  expect(link.className).toContain("after:absolute");
  expect(link.className).toContain("after:-inset-y-1");
  fireEvent.click(link);
  expect(opened).toHaveBeenCalledWith("t1", "box");
});
