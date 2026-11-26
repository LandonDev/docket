// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Go to File's field is its list's combobox: a reader hears the row the
 * arrows are on (`aria-activedescendant`), and a plain text box while there
 * is nothing to pick.
 */

const FILES = ["src/app.ts", "src/main.ts", "README.md"].map((relative) => ({
  path: `/srv/app/${relative}`,
  relative,
  name: relative.slice(relative.lastIndexOf("/") + 1),
}));

const index = vi.hoisted(() => ({ fail: false }));
vi.mock("../lib/fileIndex", () => ({
  loadProjectFiles: () => (index.fail ? Promise.reject(new Error("ENOENT: rg not found at /usr/bin/rg")) : Promise.resolve(FILES)),
  peekProjectFiles: () => (index.fail ? null : FILES),
  recentOpenedFiles: () => [],
  rankProjectFiles: (files: typeof FILES, query: string) =>
    files.filter((file) => file.relative.includes(query.trim())).map((file) => ({ ...file, positions: [] })),
}));
vi.mock("../lib/recents", () => ({ looksLikeProject: () => true }));
vi.mock("./FileTypeIcon", () => ({ FileTypeIcon: () => null }));

import { FilePicker } from "./FilePicker";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

async function mount() {
  await act(async () => {
    render(<FilePicker open cwd="/srv/app" onOpenFile={vi.fn()} onClose={vi.fn()} />);
  });
  return screen.getByRole("combobox", { name: "Go to file" });
}

describe("FilePicker", () => {
  it("names the highlighted row to a reader, and follows the arrows", async () => {
    const field = await mount();
    const list = screen.getByRole("listbox", { name: "Files" });
    expect(field.getAttribute("aria-controls")).toBe(list.id);
    const rows = screen.getAllByRole("option");
    expect(field.getAttribute("aria-activedescendant")).toBe(rows[0].id);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.getAttribute("aria-activedescendant")).toBe(rows[1].id);
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.getAttribute("aria-activedescendant")).toBe(rows[2].id);
  });

  it("is a plain field with nothing to name while no file matches", async () => {
    const field = await mount();
    fireEvent.change(field, { target: { value: "zzz" } });
    const plain = screen.getByRole("textbox", { name: "Go to file" });
    expect(plain.hasAttribute("aria-activedescendant")).toBe(false);
    expect(plain.hasAttribute("aria-controls")).toBe(false);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("says a listing that failed in its own words, never the host's raw text", async () => {
    index.fail = true;
    await act(async () => {
      render(<FilePicker open cwd="/srv/app" onOpenFile={vi.fn()} onClose={vi.fn()} />);
    });
    expect(screen.getByText("Couldn't list this project's files")).toBeTruthy();
    expect(document.body.textContent).not.toContain("ENOENT");
    index.fail = false;
  });
});
