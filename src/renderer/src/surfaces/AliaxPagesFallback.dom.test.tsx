// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { openAccountsPage, shellStore } from "../stores/shell";
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

  it("draws Stats' 672px column, not account rows on the table's width, while Stats loads", () => {
    act(() => shellStore.setState((state) => openAccountsPage(state, "stats")));
    const { container } = render(<AliaxPagesFallback />);
    expect(screen.getByRole("status", { name: "Loading stats" }).getAttribute("data-surface-skeleton")).toBe("column");
    expect(container.querySelector('[data-slot="account-row-skeleton"]')).toBeNull();
    expect(container.querySelector("[data-skeleton-column]")!.className).toContain("max-w-2xl");
  });
});
