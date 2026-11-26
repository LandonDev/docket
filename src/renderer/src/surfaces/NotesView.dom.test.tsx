// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The notes surface on the design system: the filter is an InputGroup, a
 * note's row is an ItemButton on the type grid, the note's Preview and Source are line tabs,
 * the source field is the Textarea and Delete asks first.
 */

const h = vi.hoisted(() => ({
  pending: null as Promise<unknown> | null,
  notes: [
    { id: "n1", slug: "gate-notes", title: "Gate notes", body: "The gate holds a merge.", createdAt: 1, updatedAt: 2 },
    { id: "n2", slug: "deploy", title: "Deploy", body: "Ship on green.", createdAt: 1, updatedAt: 1 },
  ],
}));

vi.mock("../lib/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/notes")>()),
  loadNotes: () => h.pending ?? Promise.resolve(h.notes),
  upsertNote: vi.fn((_env: string, note: { id: string }) => Promise.resolve({ ...h.notes[0], ...note })),
  deleteNote: vi.fn(() => Promise.resolve()),
  createNote: vi.fn((_env: string, note: object) => Promise.resolve({ id: "n3", slug: "untitled", createdAt: 3, updatedAt: 3, ...note })),
}));
vi.mock("../lib/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/connection")>()),
  registry: { primary: () => ({ environmentId: "local" }), environment: () => ({ name: "The box" }) },
}));
vi.mock("../hooks/useTabGroupLogos", () => ({ useTabGroupLogos: () => ({}) }));
vi.mock("./AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => <div data-markdown>{text}</div>,
  MarkdownSourceHighlight: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("../chrome/TitleBar", () => ({ OverlayNav: () => null }));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));

import { NotesView } from "./NotesView";
import { createNote, deleteNote, upsertNote } from "../lib/notes";

afterEach(cleanup);

const onClose = vi.fn();

async function mount() {
  onClose.mockClear();
  const view = render(<NotesView besideRail onClose={onClose} />);
  await act(async () => {});
  return view;
}

describe("the notes view", () => {
  it("filters through the group field and selects a note from its row button", async () => {
    const view = await mount();
    const filter = view.getByLabelText("Filter notes");
    expect(filter.closest('[data-slot="input-group"]')).not.toBeNull();
    const row = view.getByRole("button", { name: /Deploy/ });
    expect(row.getAttribute("data-slot")).toBe("item");
    expect(row.getAttribute("data-size")).toBe("sm");
    expect(row.querySelector("[data-row-title]")?.className).toContain("leading-5");
    expect(view.container.querySelector('[aria-label="Notes"] ul')?.innerHTML).not.toContain("leading-snug");
    fireEvent.click(row);
    expect(row.getAttribute("aria-current")).toBe("true");
    expect((view.getByLabelText("Note title") as HTMLInputElement).value).toBe("Deploy");
    fireEvent.change(filter, { target: { value: "gate" } });
    expect(view.queryByRole("button", { name: /Deploy/ })).toBeNull();
  });

  it("sets a note's project glyph 8px from its name", async () => {
    const saved = h.notes;
    h.notes = [{ ...saved[1], sourceCwd: "/Users/me/IdeaProjects/temp-code" } as (typeof saved)[number]];
    try {
      const view = await mount();
      const name = view.getAllByText("temp-code").find((el) => el.className.includes("truncate"))!;
      expect(name.parentElement!.className.split(/\s+/)).toContain("gap-2");
      expect(name.parentElement!.className.split(/\s+/)).not.toContain("gap-1.5");
    } finally {
      h.notes = saved;
    }
  });

  it("never prints a note's slug: its title is its one name", async () => {
    const view = await mount();
    fireEvent.click(view.getByRole("button", { name: /Gate notes/ }));
    const header = view.container.querySelector("[data-note-detail] header") as HTMLElement;
    expect(header.textContent).not.toContain("gate-notes");
    expect((view.getByLabelText("Note title") as HTMLInputElement).value).toBe("Gate notes");
  });

  it("switches Preview and Source with line tabs, the source a Textarea", async () => {
    const view = await mount();
    // The view remembers the last note across showings; pick the first.
    fireEvent.click(view.getByRole("button", { name: /Gate notes/ }));
    const source = view.getByRole("tab", { name: "Source" });
    await act(async () => {
      fireEvent.click(source);
    });
    expect(source.getAttribute("aria-selected")).toBe("true");
    const field = view.getByLabelText("Note source");
    expect(field.getAttribute("data-slot")).toBe("textarea");
    expect((field as HTMLTextAreaElement).value).toBe("The gate holds a merge.");
  });

  it("asks before Delete", async () => {
    const view = await mount();
    const del = view.getByRole("button", { name: "Delete" });
    expect(del.getAttribute("data-slot")).toBe("button");
    await act(async () => {
      fireEvent.click(del);
    });
    expect(view.getByText("Delete note?")).toBeTruthy();
  });

  it("deletes inside the confirm, which plays its exit before the list moves on; a refusal is its red line", async () => {
    const view = await mount();
    fireEvent.click(view.getByRole("button", { name: /Deploy/ }));
    vi.mocked(deleteNote).mockRejectedValueOnce(new Error("The host did not answer"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Delete" }));
    });
    const dialog = view.getByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    expect(within(view.getByRole("alertdialog")).getByText("The host did not answer")).toBeTruthy();
    expect((view.getByLabelText("Note title") as HTMLInputElement).value).toBe("Deploy");
    const closed: boolean[] = [];
    const watch = new MutationObserver(() => closed.push(dialog.hasAttribute("data-closed")));
    watch.observe(dialog, { attributes: true });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
    watch.disconnect();
    // The dialog closed itself while its note was still on screen.
    expect(closed).toContain(true);
    expect(deleteNote).toHaveBeenLastCalledWith("local", "n2");
  });

  it("leaves Escape inside the Delete confirm to the confirm, and closes from the page", async () => {
    const view = await mount();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Delete" }));
    });
    const cancel = view.getByRole("button", { name: "Cancel" });
    expect(cancel.closest('[role="alertdialog"]')).not.toBeNull();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lets a focused field go on Escape and keeps its text", async () => {
    const view = await mount();
    const title = view.getByLabelText("Note title") as HTMLInputElement;
    title.focus();
    fireEvent.keyDown(title, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(title);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("draws the list's skeleton alone while the notes load: the detail says nothing", async () => {
    h.pending = new Promise(() => {});
    try {
      const view = await mount();
      expect(view.getAllByRole("status")).toHaveLength(1);
      expect(view.queryByText("Select a note")).toBeNull();
    } finally {
      h.pending = null;
    }
  });

  it("with no notes says so once and offers New note", async () => {
    const saved = h.notes;
    h.notes = [];
    try {
      const view = await mount();
      expect(view.getAllByText("No notes yet")).toHaveLength(1);
      expect(view.queryByText("Select a note")).toBeNull();
      const action = view.getAllByRole("button", { name: "New note" }).find((el) => el.closest('[data-slot="empty"]'));
      expect(action).toBeTruthy();
      await act(async () => {
        fireEvent.click(action!);
      });
      expect(createNote).toHaveBeenCalled();
    } finally {
      h.notes = saved;
    }
  });

  it("a filter that matches nothing says so and Clear filter lists the notes again", async () => {
    const view = await mount();
    const filter = view.getByLabelText("Filter notes") as HTMLInputElement;
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(view.getByText("No matching notes")).toBeTruthy();
    expect(view.getByText("The filter is narrowing this list")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Clear filter" }));
    expect(filter.value).toBe("");
    expect(view.getByRole("button", { name: /Deploy/ })).toBeTruthy();
  });

  it("opens only a listed note: a filter that hides it blanks the detail, and clearing the filter brings it back", async () => {
    const view = await mount();
    fireEvent.click(view.getByRole("button", { name: /Deploy/ }));
    const filter = view.getByLabelText("Filter notes") as HTMLInputElement;
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(view.getByText("No matching notes")).toBeTruthy();
    expect(view.queryByLabelText("Note title")).toBeNull();
    expect(view.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.change(filter, { target: { value: "gate" } });
    expect(view.queryByLabelText("Note title")).toBeNull();
    fireEvent.change(filter, { target: { value: "" } });
    expect((view.getByLabelText("Note title") as HTMLInputElement).value).toBe("Deploy");
  });

  it("keeps the open note listed while its own edit stops it matching the filter", async () => {
    const view = await mount();
    fireEvent.click(view.getByRole("button", { name: /Deploy/ }));
    fireEvent.change(view.getByLabelText("Filter notes"), { target: { value: "green" } });
    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "Source" }));
    });
    fireEvent.change(view.getByLabelText("Note source"), { target: { value: "Ship on red." } });
    await waitFor(() => expect(vi.mocked(upsertNote)).toHaveBeenCalledWith("local", expect.objectContaining({ id: "n2", body: "Ship on red." })), { timeout: 2000 });
    await act(async () => {});
    expect(view.getByRole("button", { name: /Deploy/ })).toBeTruthy();
    expect((view.getByLabelText("Note source") as HTMLTextAreaElement).value).toBe("Ship on red.");
  });

  it("moves through the list with the arrows from the field, and the list is one tab stop", async () => {
    Element.prototype.scrollIntoView = () => {};
    const view = await mount();
    const rows = () => view.getAllByRole("button").filter((el) => el.hasAttribute("data-roving-key"));
    fireEvent.click(rows()[0]!);
    expect(rows().filter((row) => row.tabIndex === 0)).toHaveLength(1);
    const filter = view.getByLabelText("Filter notes");
    filter.focus();
    await act(async () => {
      fireEvent.keyDown(filter, { key: "ArrowDown" });
    });
    expect(rows()[1]!.getAttribute("aria-current")).toBe("true");
    expect(rows()[1]!.tabIndex).toBe(0);
    expect(rows()[0]!.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(filter);
    // On a row, the arrows move focus with the selection; the ends hold.
    rows()[1]!.focus();
    await act(async () => {
      fireEvent.keyDown(rows()[1]!, { key: "ArrowDown" });
    });
    expect(rows()[1]!.getAttribute("aria-current")).toBe("true");
    await act(async () => {
      fireEvent.keyDown(rows()[1]!, { key: "ArrowUp" });
    });
    expect(rows()[0]!.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("frames itself as the Inbox does: the strip's medium label, the detail's 24px sections", async () => {
    const view = await mount();
    const label = [...view.container.querySelectorAll("span")].find((el) => el.textContent === "Notes")!;
    expect(label.className).toContain("font-medium");
    expect(view.container.querySelector("[data-note-detail]")!.className).toContain("gap-6");
    // A note with no project has nothing over its title, so the title starts the header.
    expect((view.getByLabelText("Note title") as HTMLElement).className.split(/\s+/)).not.toContain("mt-2");
  });

  it("says a failed New note over the listed notes as one red line under the list's head", async () => {
    const view = await mount();
    vi.mocked(createNote).mockRejectedValueOnce(new Error("SQLITE_FULL: database or disk is full"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "New note" }));
    });
    const line = view.getByRole("alert");
    expect(line.textContent).toBe("Couldn't make a note");
    expect(line.className).toContain("text-destructive");
    expect(view.container.textContent).not.toContain("SQLITE_FULL");
    // The notes stay listed under it.
    expect(view.getByRole("button", { name: /Deploy/ })).toBeTruthy();
  });

  it("with no note to show, a failed load is the list's one empty state, the host named, with Retry", async () => {
    const failed = Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8787"));
    failed.catch(() => {});
    h.pending = failed;
    try {
      const view = await mount();
      const empty = view.container.querySelector('[data-slot="empty"]')!;
      expect(empty.textContent).toContain("Couldn't load notes on the box");
      expect(view.container.textContent).not.toContain("ECONNREFUSED");
      h.pending = null;
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Retry" }));
      });
      expect(view.queryByText("Couldn't load notes on the box")).toBeNull();
      expect(view.getByRole("button", { name: /Deploy/ })).toBeTruthy();
    } finally {
      h.pending = null;
    }
  });

  it("marks the title field's focus with the field's own edge, never the caret alone", async () => {
    const view = await mount();
    const title = (view.getByLabelText("Note title") as HTMLElement).className.split(/\s+/);
    expect(title).toContain("focus-field");
    // A bottom edge, clear at rest, that focus-field inks with the ring.
    expect(title).toContain("border-b");
    expect(title).toContain("border-transparent");
  });

  it("seats its empty state where the Inbox seats its own: centred in the list's column", async () => {
    const saved = h.notes;
    h.notes = [];
    try {
      const view = await mount();
      const empty = view.container.querySelector('[data-slot="empty"]') as HTMLElement;
      const scroller = empty.parentElement!.className.split(/\s+/);
      expect(scroller).toContain("flex");
      expect(scroller).toContain("flex-col");
      expect(empty.className).toContain("flex-1");
      expect(empty.className).toContain("justify-center");
    } finally {
      h.notes = saved;
    }
  });

  it("insets its detail 16px in a narrow pane and 32px from 576px", async () => {
    const view = await mount();
    const detail = view.container.querySelector("[data-note-detail]")!;
    expect(detail.parentElement!.className).toContain("@container/detail");
    const classes = detail.className.split(/\s+/);
    expect(classes).toContain("px-4");
    expect(classes).toContain("@xl/detail:px-8");
    expect(classes).not.toContain("px-8");
  });
});
