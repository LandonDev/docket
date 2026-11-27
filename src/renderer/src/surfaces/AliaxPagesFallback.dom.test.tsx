// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { openAccountsPage, shellStore } from "../stores/shell";
import { STATS_SECTIONS } from "./statsSkeletonShape";
import { AliaxPagesFallback } from "./AliaxPagesFallback";

/** One chunk holds Accounts and Stats; its wait is drawn in the shape of the page asked for. */

afterEach(() => {
  cleanup();
  act(() => shellStore.setState({ accountsPage: null }));
});

describe("the Accounts and Stats pages' fallback", () => {
  it("draws Accounts' rows while Accounts loads", () => {
    act(() => shellStore.setState((state) => openAccountsPage(state, "accounts")));
    render(<AliaxPagesFallback />);
    expect(screen.getByRole("status", { name: "Loading accounts" }).getAttribute("data-surface-skeleton")).toBe("accounts");
  });

  it("draws Stats' own wait, its sections over their charts' bones in the 672px column, while Stats loads", () => {
    act(() => shellStore.setState((state) => openAccountsPage(state, "stats")));
    const { container } = render(<AliaxPagesFallback />);
    expect(screen.getByRole("status", { name: "Loading stats" }).getAttribute("data-surface-skeleton")).toBe("stats");
    expect(container.querySelector('[data-slot="account-row-skeleton"]')).toBeNull();
    expect(container.querySelector("[data-skeleton-column]")!.className).toContain("max-w-2xl");
    // No settings rows: each section's heading, then the bone its chart holds, as tall as the page's own wait draws it.
    const bones = [...container.querySelectorAll<HTMLElement>("[data-section-skeleton]")];
    expect(bones.map((b) => b.dataset.sectionSkeleton)).toEqual(STATS_SECTIONS.map((s) => s.title));
    expect(bones.map((b) => b.style.height)).toEqual(STATS_SECTIONS.map((s) => `${s.height}px`));
    expect(bones[0]!.previousElementSibling!.textContent).toBe("Pace");
    expect(container.querySelectorAll(".h-8.w-40")).toHaveLength(0);
  });
});
