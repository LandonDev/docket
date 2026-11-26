// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxListEmpty } from "./InboxView";

/** The inbox list with nothing to show: one title and one line per case,
 *  and Clear filters only when the person narrowed it. */

afterEach(cleanup);

const view = (props: Partial<Parameters<typeof InboxListEmpty>[0]> = {}) =>
  render(<InboxListEmpty narrowed={false} source="github" githubWorkspaces={2} onClearFilters={vi.fn()} {...props} />);

describe("InboxListEmpty", () => {
  it("narrowed: says the filters are narrowing it and clears them", () => {
    const onClearFilters = vi.fn();
    const { getByText, getByRole } = view({ narrowed: true, onClearFilters });
    expect(getByText("Nothing matches")).toBeTruthy();
    expect(getByText("Filters are narrowing this list")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Clear filters" }));
    expect(onClearFilters).toHaveBeenCalledOnce();
  });

  it("Linear: says so in its title alone, with no button", () => {
    const { getByText, queryByRole, container } = view({ source: "linear" });
    expect(getByText("No Linear issues")).toBeTruthy();
    expect(container.querySelector('[data-slot="empty-description"]')).toBeNull();
    expect(queryByRole("button")).toBeNull();
  });

  it("GitHub with no workspaces: says how to add one", () => {
    const { getByText } = view({ githubWorkspaces: 0 });
    expect(getByText("No GitHub workspaces")).toBeTruthy();
    expect(getByText("Add a GitHub repository as a workspace.")).toBeTruthy();
  });

  it("GitHub across every workspace: the title alone, no line explaining it", () => {
    const { getByText, queryByRole, container } = view();
    expect(getByText("No issues or pull requests")).toBeTruthy();
    expect(container.querySelector('[data-slot="empty-description"]')).toBeNull();
    expect(queryByRole("button")).toBeNull();
  });

  it("scoped: names the one workspace and offers the rest as its action", () => {
    const onShowAll = vi.fn();
    const { getByText, getByRole, container } = view({ scopedTo: "temp-code", onShowAll });
    expect(getByText("Nothing open in temp-code")).toBeTruthy();
    expect(container.textContent).not.toContain("GitHub workspaces show here");
    fireEvent.click(getByRole("button", { name: "Show all workspaces" }));
    expect(onShowAll).toHaveBeenCalledOnce();
  });
});
