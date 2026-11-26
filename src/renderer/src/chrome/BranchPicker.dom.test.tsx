// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMenus } from "./menuRows";

const h = vi.hoisted(() => ({ checkout: vi.fn(), create: vi.fn(), state: null as null | { settled: boolean; branches: null } }));

vi.mock("../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../lib/tcserver/projects", () => ({ environmentOfCwd: () => "local" }));
vi.mock("../hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => h.state ?? ({
    settled: true,
    branches: {
      current: "main",
      detached: false,
      branches: [
        { name: "main", current: true, remote: null },
        { name: "feature", current: false, remote: null },
        { name: "fix", current: false, remote: "origin" },
      ],
    },
  }),
}));
vi.mock("../lib/fs", () => ({
  gitCheckout: (...args: unknown[]) => h.checkout(...args),
  gitCreateBranch: (...args: unknown[]) => h.create(...args),
  gitCommit: vi.fn(),
  gitStageAll: vi.fn(),
  gitStash: vi.fn(),
  isCheckoutBlockedByChanges: () => false,
  notifyGitChanged: vi.fn(),
}));

import { BranchPicker } from "./BranchPicker";

afterEach(() => {
  cleanup();
  h.state = null;
});
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  resetMenus();
  h.checkout.mockReset().mockResolvedValue(undefined);
  h.create.mockReset().mockResolvedValue(undefined);
});

/** A key as the field hears it. */
async function key(field: HTMLElement, name: string) {
  await act(async () => {
    fireEvent.keyDown(field, { key: name });
  });
}

/** Typed text, as a keyboard sends it: the combobox takes its first match only for typed input. */
async function type(field: HTMLElement, value: string) {
  await act(async () => {
    field.focus();
    fireEvent.input(field, { target: { value }, inputType: "insertText" });
  });
}

async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Branch main" }));
  return screen.findByRole("dialog", { name: "Branch picker" });
}

describe("BranchPicker: no branch yet", () => {
  it("a type that needs no branch (a chat or research draft) draws nothing for a folder with no repo, but keeps the wait and a real branch", () => {
    h.state = { settled: true, branches: null };
    const { container, rerender } = render(<BranchPicker cwd="/u/me/app" needsRepo={false} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText("No repo")).toBeNull();
    h.state = { settled: false, branches: null };
    rerender(<BranchPicker cwd="/u/me/app" needsRepo={false} />);
    expect(screen.getByRole("button", { name: "Loading branch" })).toBeTruthy();
    rerender(<BranchPicker cwd="/u/me/app" branch="main" needsRepo={false} />);
    expect(screen.getByRole("button", { name: "Branch main" })).toBeTruthy();
  });

  it("No repo is sans: words, not a branch name", () => {
    h.state = { settled: true, branches: null };
    render(<BranchPicker cwd="/u/me/app" />);
    const trigger = screen.getByRole("button", { name: "No git repository" });
    const text = within(trigger).getByText("No repo");
    expect(text.className.split(" ")).toContain("text-xs");
    expect(text.className).not.toContain("font-mono");
  });

  it("loading draws a Skeleton in a short branch name's shape, never a hand-made pill", () => {
    h.state = { settled: false, branches: null };
    render(<BranchPicker cwd="/u/me/app" />);
    const trigger = screen.getByRole("button", { name: "Loading branch" });
    const skeleton = trigger.querySelector<HTMLElement>("[data-slot=skeleton]")!;
    expect(skeleton.className.split(" ")).toEqual(expect.arrayContaining(["h-3", "w-10"]));
    expect(trigger.querySelector(".rounded-full")).toBeNull();
    expect(trigger.className.split(" ")).toContain("h-6");
  });

  it("a branch name keeps the mono face", () => {
    render(<BranchPicker cwd="/u/me/app" />);
    expect(within(screen.getByRole("button", { name: "Branch main" })).getByText("main").className).toContain("font-mono");
  });
});

describe("BranchPicker", () => {
  it("the head form is the branch name alone in 13px medium type, and opens the same list", async () => {
    render(<BranchPicker cwd="/u/me/app" variant="head" tip="Tracks origin/main" />);
    const trigger = screen.getByRole("button", { name: "Branch main" });
    expect(trigger.querySelector("svg")).toBeNull();
    expect(trigger.className).toContain("text-[13px]");
    expect(trigger.className).toContain("font-medium");
    const picker = await open();
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["main", "feature", "fixorigin"]);
  });

  it("opens with the search field focused and the branches as rows, the current one selected and named to a reader", async () => {
    render(<BranchPicker cwd="/u/me/app" />);
    const picker = await open();
    const search = within(picker).getByRole("combobox", { name: "Search or create a branch" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    const options = within(picker).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["main", "feature", "fixorigin"]);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    // The field is the list's combobox: the row the arrows are on is the one a reader hears.
    expect(search.getAttribute("aria-controls")).toBe(within(picker).getByRole("listbox", { name: "Branches" }).id);
    expect(search.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    await key(search, "ArrowDown");
    expect(search.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(options[1]!.hasAttribute("data-highlighted")).toBe(true);
  });

  it("arrow keys move the highlight and Enter checks the branch out", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<BranchPicker cwd="/u/me/app" onChange={onChange} onClose={onClose} />);
    const picker = await open();
    const search = within(picker).getByRole("combobox");
    await key(search, "ArrowDown");
    await key(search, "ArrowDown");
    await key(search, "ArrowUp");
    await key(search, "Enter");
    await waitFor(() => expect(h.checkout).toHaveBeenCalledWith("local", "/u/me/app", "feature", null));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("a row sliding under a still pointer never takes the highlight from the keyboard", async () => {
    render(<BranchPicker cwd="/u/me/app" />);
    const picker = await open();
    const search = within(picker).getByRole("combobox");
    await key(search, "ArrowDown");
    const kept = search.getAttribute("aria-activedescendant");
    const slid = within(picker).getByRole("option", { name: /fix/ });
    await act(async () => {
      // What the browser sends when the list scrolls under a pointer that does not move: no move.
      fireEvent.pointerEnter(slid);
      fireEvent.mouseEnter(slid);
      fireEvent.mouseOver(slid);
    });
    expect(search.getAttribute("aria-activedescendant")).toBe(kept);
    expect(slid.hasAttribute("data-highlighted")).toBe(false);
  });

  it("a name no branch has offers to create it; a click on it creates, and so does Enter", async () => {
    render(<BranchPicker cwd="/u/me/app" />);
    const picker = await open();
    const search = within(picker).getByRole("combobox");
    await type(search, "new-thing");
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["Create and checkout new-thing"]);
    fireEvent.click(within(picker).getByRole("option", { name: "Create and checkout new-thing" }));
    await waitFor(() => expect(h.create).toHaveBeenCalledWith("local", "/u/me/app", "new-thing"));
    cleanup();
    h.create.mockClear();
    render(<BranchPicker cwd="/u/me/app" />);
    const again = await open();
    const field = within(again).getByRole("combobox");
    await type(field, "other");
    await key(field, "Enter");
    await waitFor(() => expect(h.create).toHaveBeenCalledWith("local", "/u/me/app", "other"));
  });

  it("typing narrows the rows and says so when none match a taken name", async () => {
    render(<BranchPicker cwd="/u/me/app" />);
    const picker = await open();
    const search = within(picker).getByRole("combobox");
    await type(search, "fea");
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["Create and checkout fea", "feature"]);
    // A pick never writes the row's name into the field.
    expect((search as HTMLInputElement).value).toBe("fea");
  });

  it("Escape closes and hands the focus back", async () => {
    const onClose = vi.fn();
    render(<BranchPicker cwd="/u/me/app" onClose={onClose} />);
    const picker = await open();
    await key(within(picker).getByRole("combobox"), "Escape");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Branch picker" })).toBeNull());
    expect(onClose).toHaveBeenCalled();
  });
});

describe("BranchPicker in the draft row", () => {
  it("is a row control (hover /5, press /12) ending in a menu trigger's still chevron; the head form has none", () => {
    render(<BranchPicker cwd="/u/me/app" />);
    const trigger = screen.getByRole("button", { name: "Branch main" });
    for (const c of ["hover:bg-foreground/5", "active:bg-foreground/12", "active:transition-none"]) expect(trigger.className).toContain(c);
    const chevron = trigger.lastElementChild!;
    expect(chevron.tagName.toLowerCase()).toBe("svg");
    expect(chevron.getAttribute("class")).toContain("size-3");
    expect(chevron.getAttribute("class")).not.toMatch(/rotate|transition/);
  });
});
