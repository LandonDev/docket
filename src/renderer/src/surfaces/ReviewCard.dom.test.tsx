// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewFinding } from "@server/shared/review";

const mergeAnyway = vi.fn<(sessionId: string, runId: string) => Promise<void>>(() => new Promise(() => {}));
vi.mock("../lib/tcserver/commands", () => ({
  mergeAnyway: (sessionId: string, runId: string) => mergeAnyway(sessionId, runId),
}));
vi.mock("../lib/threads/agents", () => ({ modelLabel: () => "GPT-6.1 Sol" }));

import type { Block } from "../lib/session";
import { TranscriptSessionContext } from "./transcriptSession";
import { ReviewCard, detailOf, mergeErrorWords } from "./ReviewCard";
import { CARD_SHAPE } from "./QuestionCard";

const finding = (file: string, line: number, summary: string, scenario = ""): ReviewFinding => ({
  file,
  line,
  summary,
  failure_scenario: scenario,
});
const review = (over: Partial<NonNullable<Block["review"]>>): Block => ({
  id: "r",
  role: "system",
  text: "",
  review: {
    runId: "run1",
    reviewerId: "rev1",
    provider: "codex",
    model: "gpt-6.1-sol",
    outcome: "pass",
    branch: "feature",
    target: "master",
    blocking: [],
    minor: [],
    merged: true,
    pushed: true,
    ...over,
  } as NonNullable<Block["review"]>,
});
const mount = (block: Block, onOpenFile = vi.fn()) =>
  render(
    <TranscriptSessionContext.Provider value="s1">
      <ReviewCard block={block} cwd="/repo" onOpenFile={onOpenFile} />
    </TranscriptSessionContext.Provider>,
  );

afterEach(() => {
  cleanup();
  mergeAnyway.mockClear();
});

describe("ReviewCard", () => {
  it("a pass is one line with its minor count, the minor findings closed", () => {
    const { container } = mount(review({ minor: [finding("a.ts", 3, "Nit")] }));
    expect(container.querySelectorAll('[data-slot="notice-line"]').length).toBe(1);
    // The lead is a whole clause: it ends in a colon, so it never runs into the details.
    expect(container.querySelector('[data-slot="notice-line"] .font-medium')!.textContent).toBe("Reviewed by GPT-6.1 Sol:");
    expect(container.textContent).toContain("no blocking findings");
    expect(container.textContent).toContain("1 minor");
    expect(container.textContent).not.toContain("Nit");
    fireEvent.click(screen.getByRole("button", { name: "Show minor findings" }));
    expect(container.textContent).toContain("Nit");
  });

  it("a live hold is a card listing file:line, summary and scenario", () => {
    const onOpenFile = vi.fn();
    const { container } = mount(
      review({ outcome: "held", merged: false, blocking: [finding("src/x.ts", 12, "Drops the error", "A 500 reads as success")] }),
      onOpenFile,
    );
    const card = container.querySelector('[data-slot="review-hold"]')!;
    expect(card).not.toBeNull();
    // The question card's frame, by the one name, and no margin of its own: the row gap spaces it.
    for (const cls of CARD_SHAPE.split(" ")) expect(card.className.split(" ")).toContain(cls);
    expect(card.className).not.toMatch(/\bmy-\d/);
    // Its facts are one comma run, never two muted facts set apart by space alone.
    expect(card.querySelector('[data-review-head] [data-slot="facts"]')!.textContent).toBe("1 blocking findingmerge held");
    expect(card.querySelector('[data-review-head] [data-slot="facts"]')!.className).toContain("[&>span:not(:last-child)]:after:content-[',']");
    expect(card.textContent).toContain("Drops the error");
    expect(card.textContent).toContain("A 500 reads as success");
    expect(card.textContent).not.toContain("Address the findings");
    // The head line: the glyph 8px from the title (the line's 4px and its own 4px), each fact 4px apart.
    const head = card.querySelector<HTMLElement>("[data-review-head]")!;
    expect(head.className.split(" ")).toContain("gap-1");
    expect(head.className.split(" ")).not.toContain("gap-2");
    expect((head.firstElementChild as HTMLElement).className.split(" ")).toContain("me-1");
    // A 20px file button reaches 24px through its hit area.
    // The file's name and line on screen, never its path (the tooltip holds it).
    expect(screen.getByRole("button", { name: "x.ts:12" }).className).toContain("after:-inset-y-0.5");
    expect(card.textContent).not.toContain("src/x.ts");
    expect(head.textContent).toContain("Reviewed by GPT-6.1 Sol:");
    // The actions sit 8px apart, as the failure card's do.
    expect(screen.getByRole("button", { name: /Merge anyway/ }).parentElement!.classList).toContain("gap-2");
    fireEvent.click(screen.getByRole("button", { name: "x.ts:12" }));
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/x.ts", { line: 12 });
  });

  it("Merge anyway calls the override and reads Merging…", async () => {
    mount(review({ outcome: "held", merged: false, blocking: [finding("x.ts", 1, "Bad")] }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Merge anyway" }));
    });
    expect(mergeAnyway).toHaveBeenCalledWith("s1", "run1");
    expect(screen.getByRole("button", { name: /Merging…/ })).toBeTruthy();
  });

  it("a refused Merge anyway says it in words, never the raw error", async () => {
    mergeAnyway.mockImplementationOnce(() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:7777")));
    const { container } = mount(review({ outcome: "held", merged: false, blocking: [finding("x.ts", 1, "Bad")] }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Merge anyway" }));
    });
    expect(container.textContent).not.toContain("ECONNREFUSED");
    expect(container.textContent).toContain("did not confirm the change");
  });

  it("an unknown refusal reads one fixed line", () => {
    expect(mergeErrorWords(new Error("spawn /usr/bin/git EAGAIN at Foo.bar (/x/y.ts:3)"))).toBe("Merge anyway did not go through. Try again.");
  });

  it("settled lines: a timeout with no minutes drops the part, an override keeps its preposition, an outcome that never ran wears Stopped", () => {
    expect(detailOf(review({ outcome: "timeout" }).review!)).toEqual(["merged without it"]);
    expect(detailOf(review({ outcome: "timeout", minutes: 15 }).review!)).toEqual(["after 15 min", "merged without it"]);
    expect(detailOf(review({ outcome: "merged-anyway", blocking: [finding("a.ts", 1, "A"), finding("b.ts", 2, "B")] }).review!)).toEqual(["over 2 blocking findings"]);
    const { container } = mount(review({ outcome: "failed", reason: "the reviewer ended without reporting" }));
    expect(container.querySelector('[data-slot="notice-line"] .font-medium')!.textContent).toBe("Review by GPT-6.1 Sol did not run:");
    expect(container.textContent).not.toContain("?");
    expect(container.querySelector('[data-slot="status-mark"][data-state="stopped"]')).not.toBeNull();
  });

  it("a hold's minor findings stay collapsed", () => {
    const { container } = mount(
      review({ outcome: "held", merged: false, blocking: [finding("x.ts", 1, "Bad")], minor: [finding("y.ts", 2, "Small thing")] }),
    );
    expect(container.textContent).toContain("1 minor finding");
    expect(container.textContent).not.toContain("Small thing");
    // The fold's chevron turns with it.
    const trigger = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("1 minor finding"))!;
    const chevron = trigger.querySelector("svg")!;
    expect(chevron.getAttribute("class")).toContain("duration-(--dur-base)");
    expect(chevron.getAttribute("class")).not.toContain("rotate-90");
    // 8px after the count (the button's 4px gap and its own 4px), lifting with the words: no tone of its own.
    expect(chevron.getAttribute("class")).toContain("ms-1");
    expect(chevron.getAttribute("class")).not.toContain("text-muted-foreground");
    fireEvent.click(trigger);
    expect(trigger.querySelector("svg")!.getAttribute("class")).toContain("rotate-90");
  });
});
