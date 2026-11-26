// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Escape belongs to the innermost layer: the inbox closes on Escape only
 *  when no field, menu or dialog inside it took the key first. */

vi.mock("../hooks/useTabGroupLogos", () => ({ useTabGroupLogos: () => ({}) }));
vi.mock("../chrome/TitleBar", () => ({ OverlayNav: () => null }));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));

import { InboxView } from "./InboxView";
import { saveInboxSource } from "../lib/inboxFilters";

afterEach(cleanup);

async function mount() {
  const onClose = vi.fn();
  const view = render(<InboxView cwd="/tmp/project" besideRail onClose={onClose} />);
  await act(async () => {});
  return { view, onClose };
}

describe("the inbox's Escape", () => {
  it("closes the inbox from the page", async () => {
    const { onClose } = await mount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets a focused field go first and keeps what it holds", async () => {
    const { view, onClose } = await mount();
    const field = view.getByLabelText("Filter inbox") as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: "gate" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(field);
    expect(field.value).toBe("gate");
  });

  it("leaves Escape to a confirm open above it", async () => {
    const { onClose } = await mount();
    const confirm = document.createElement("div");
    confirm.setAttribute("role", "alertdialog");
    const button = document.createElement("button");
    confirm.append(button);
    document.body.append(confirm);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    confirm.remove();
  });
});

describe("the inbox list while it first loads", () => {
  it("draws the state kit's rows, the row's own shape", async () => {
    saveInboxSource("linear");
    try {
      const { view } = await mount();
      const skeleton = view.container.querySelector('[data-surface-skeleton="rows"]');
      expect(skeleton?.getAttribute("aria-label")).toBe("Loading inbox");
      expect(skeleton?.querySelectorAll("[data-skeleton-row]")).toHaveLength(5);
    } finally {
      saveInboxSource("github");
    }
  });
});

describe("the inbox list's failures", () => {
  it("says a source's failure as one red line, its raw text on hover alone", async () => {
    const { InboxFailLines } = await import("./InboxView");
    const view = render(<InboxFailLines words="Couldn't load Linear issues" detail="fetch failed: ECONNRESET" repos={[{ repo: "o/a", error: "HTTP 404" }]} />);
    const lines = view.getAllByRole("alert");
    // The source's line stands alone: a repo's line under a failed source says nothing new.
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe("Couldn't load Linear issues");
    expect(lines[0].className).toContain("text-destructive");
    expect(view.container.textContent).not.toContain("ECONNRESET");
  });

  it("names a repo it could not read in red, no colon and no raw text", async () => {
    const { InboxFailLines } = await import("./InboxView");
    const view = render(<InboxFailLines words={null} detail={null} repos={[{ repo: "o/a", error: "gh: Could not resolve to a Repository" }]} />);
    const line = view.getByRole("alert");
    expect(line.textContent).toBe("Couldn't read o/a");
    expect(line.textContent).not.toContain(":");
    expect(line.className).toContain("text-destructive");
    expect(line.className).not.toContain("text-muted-foreground");
  });
});
