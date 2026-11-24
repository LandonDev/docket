// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry, type Link } from "../lib/connection";
import { NewThreadChooser } from "./NewThreadChooser";
import { threadTuneChunk } from "../surfaces/chunks";

// The tune view's rules come from the host; with none loaded it shows the instructions field alone.
vi.mock("../lib/tcserver/rules", () => ({ useRulesScope: () => ({ scope: undefined, catalog: null }) }));
const catalog = vi.hoisted(() => ({ workspaces: [] as { id: string; environmentId: string; kind?: string }[] }));
vi.mock("../lib/tcserver/workspaces", () => ({ useWorkspaces: () => catalog.workspaces }));

beforeEach(() => {
  vi.spyOn(registry, "primary").mockReturnValue({ environmentId: "local" } as Link);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("NewThreadChooser", () => {
  it("is an icon button named New thread that opens a row per thread type", async () => {
    render(<NewThreadChooser workspaceId={null} empty={false} onStart={() => {}} />);
    const trigger = screen.getByRole("button", { name: "New thread" });
    expect(trigger.textContent).toBe("");
    expect(trigger.getAttribute("data-tauri-drag-region")).toBe("false");
    await click(trigger);
    const titles = [...(await screen.findByRole("dialog")).querySelectorAll("[data-slot=item-title]")];
    expect(titles.map((t) => t.textContent)).toEqual([
      "Chat",
      "Plan",
      "Plan the project…",
      "Implement",
      "Orchestrate",
      "Research",
    ]);
  });

  it("a Work workspace starts a chat or research alone, the chat's hint free of code", async () => {
    catalog.workspaces = [{ id: "job", environmentId: "local", kind: "work" }];
    render(<NewThreadChooser workspaceId="job" empty={false} onStart={() => {}} />);
    await click(screen.getByRole("button", { name: "New thread" }));
    const dialog = await screen.findByRole("dialog");
    expect([...dialog.querySelectorAll("[data-slot=item-title]")].map((t) => t.textContent)).toEqual(["Chat", "Research"]);
    expect(dialog.textContent).not.toContain("code");
    catalog.workspaces = [];
  });

  it("draws each type's row with its type's tinted glyph", async () => {
    render(<NewThreadChooser workspaceId={null} empty={false} onStart={() => {}} />);
    await click(screen.getByRole("button", { name: "New thread" }));
    const glyphs = [...(await screen.findByRole("dialog")).querySelectorAll("svg[data-type-glyph]")];
    expect(glyphs.map((g) => g.getAttribute("data-type-glyph"))).toEqual(["chat", "planning", "project-plan", "implementation", "orchestration", "research"]);
    for (const g of glyphs) expect(g.getAttribute("class")).toContain(`text-type-${g.getAttribute("data-type-glyph")}`);
  });

  it("starts the picked type with no rules", async () => {
    const onStart = vi.fn();
    render(<NewThreadChooser workspaceId={null} empty={false} onStart={onStart} />);
    await click(screen.getByRole("button", { name: "New thread" }));
    await click(await screen.findByRole("button", { name: /^Implement/ }));
    expect(onStart).toHaveBeenCalledWith("implementation", null);
  });

  it("opens a tunable type's options in place and starts it with the rules", async () => {
    const onStart = vi.fn();
    render(<NewThreadChooser workspaceId={null} empty={false} onStart={onStart} />);
    await click(screen.getByRole("button", { name: "New thread" }));
    // Only the two tunable types carry an options button.
    expect(screen.queryByRole("button", { name: "Chat options" })).toBeNull();
    expect(screen.getByRole("button", { name: "Orchestrate options" })).toBeTruthy();
    await click(screen.getByRole("button", { name: "Research options" }));

    expect(screen.getByText("Research options")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Chat/ })).toBeNull();
    // The tune view is threadTuneChunk's: it lands a tick after the header.
    const field = await screen.findByPlaceholderText("Custom instructions for this run…");
    await act(async () => {
      fireEvent.change(field, {
        target: { value: "  cite every claim  " },
      });
    });
    await click(screen.getByRole("button", { name: "Start research" }));
    expect(onStart).toHaveBeenCalledWith("research", { instructions: "cite every claim" });
  });

  it("warms the tune view's chunk as it opens, not before", async () => {
    const preload = vi.spyOn(threadTuneChunk, "preload");
    render(<NewThreadChooser workspaceId={null} empty={false} onStart={() => {}} />);
    expect(preload).not.toHaveBeenCalled();
    await click(screen.getByRole("button", { name: "New thread" }));
    expect(preload).toHaveBeenCalledTimes(1);
    preload.mockRestore();
  });

  it("goes back from the options to the list", async () => {
    render(<NewThreadChooser workspaceId={null} empty={false} onStart={() => {}} />);
    await click(screen.getByRole("button", { name: "New thread" }));
    await click(screen.getByRole("button", { name: "Orchestrate options" }));
    await click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: /^Chat/ })).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Orchestrate options");
  });

  it("says New thread in words when the strip is empty", () => {
    render(<NewThreadChooser workspaceId={null} empty onStart={() => {}} />);
    expect(screen.getByRole("button", { name: "New thread" }).textContent).toBe("New thread");
  });

  it("renders nothing for a workspace this window does not know", () => {
    const { container } = render(<NewThreadChooser workspaceId="ws_gone" empty={false} onStart={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
  it("a tunable row's options button waits on the shared hover reveal, on a wrapper", async () => {
    render(<NewThreadChooser workspaceId={null} empty={false} onStart={() => {}} />);
    await click(screen.getByRole("button", { name: "New thread" }));
    const tune = screen.getByRole("button", { name: "Research options" });
    const wrapper = tune.parentElement!.className;
    expect(wrapper).toContain("group-hover/row:delay-(--delay-hover)");
    expect(wrapper).toContain("group-has-focus-visible/row:opacity-100");
    expect(wrapper).not.toContain("focus-within");
    // The button keeps its own hover fill on --dur-hover.
    expect(tune.className).not.toContain("transition-opacity");
    expect(tune.className).toContain("duration-(--dur-hover)");
  });
});
