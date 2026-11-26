// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./empty";

afterEach(cleanup);

describe("Empty", () => {
  it("lets its title fill its line (pretty, never two balanced halves) and balances only the guidance", () => {
    render(
      <Empty>
        <EmptyHeader>
          <EmptyTitle>The LifeOS sign-in on the box waits for your approval</EmptyTitle>
          <EmptyDescription>Sign in from a computer that manages the box</EmptyDescription>
        </EmptyHeader>
      </Empty>,
    );
    const title = screen.getByText(/LifeOS sign-in/);
    const classes = (el: Element) => el.className.split(/\s+/);
    expect(classes(title)).toContain("text-pretty");
    expect(classes(title)).not.toContain("text-balance");
    expect(classes(title.closest('[data-slot="empty"]')!)).not.toContain("text-balance");
    expect(classes(screen.getByText(/Sign in from/))).toContain("text-balance");
  });
});
