// @vitest-environment jsdom
/**
 * A document on the guest's page (docs/agents/work-docs.md "Styling: the
 * format row", work-guests.md "The page"): an Edit link has the format row in
 * a place of its own, the page's first row under the header, held while the
 * text scrolls; Comment and View have none. The page says the file's name
 * once, in its header, and a View link's page has no comments margin to
 * widen it. The editor is a stand-in: it has its own tests.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;

const editors = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("work-kit/editor", async (original) => ({
  ...(await original<typeof import("work-kit/editor")>()),
  DocumentEditor: (props: Record<string, unknown>) => (editors.push(props), (<div data-fake-editor />)),
}));

const { DocPage } = await import("./DocPage");
import type { Opened, Session } from "./session";

afterEach(() => {
  cleanup();
  editors.length = 0;
});

const session = { socketUrl: () => "ws://127.0.0.1:1/g/ws/L1", refresh: async () => ({ token: "t", tokenExp: 0 }), post: async () => ({}) } as unknown as Session;
const opened = (role: Opened["role"]): Opened => ({ kind: "doc", role, title: "Run of show", expiresAt: 0, me: "guest:L1", name: "Dana Lee", doc: "kdocrun" }) as Opened;
const show = (role: Opened["role"]) => render(<main><DocPage session={session} opened={opened(role)} scheme="light" onGone={() => {}} /></main>);

describe("a document on the guest's page", () => {
  it("an Edit link has the format row in a held place of its own, before the document's column", async () => {
    const view = show("edit");
    const place = view.container.querySelector<HTMLElement>("[data-guest-row]")!;
    expect(place.className.split(" ")).toEqual(expect.arrayContaining(["sticky", "top-0", "bg-background"]));
    const column = view.container.querySelector<HTMLElement>("[data-guest-document]")!;
    expect(column.dataset.guestDocument).toBe("edit");
    expect(place.compareDocumentPosition(column) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(column.contains(place)).toBe(false);
    await waitFor(() => expect(editors.at(-1)!.formatRowInto).toBe(place));
    expect(editors.at(-1)).toMatchObject({ formatRow: true, editable: true });
  });

  it("Comment and View have no row and no place for one", () => {
    for (const role of ["comment", "view"] as const) {
      const view = show(role);
      expect(view.container.querySelector("[data-guest-row]")).toBeNull();
      expect(view.container.querySelector<HTMLElement>("[data-guest-document]")!.dataset.guestDocument).toBe(role);
      expect(editors.at(-1)).toMatchObject({ formatRow: false, editable: false });
      cleanup();
    }
  });

  it("says the file's name nowhere of its own: the page's header has it once", () => {
    const view = show("edit");
    expect(view.container.querySelector("h1")).toBeNull();
    expect(view.container.textContent).not.toContain("Run of show");
  });

  it("gives a finger 44px on the row's controls and keeps a View link's page to its width", () => {
    const css = readFileSync(join(__dirname, "guest.css"), "utf8");
    const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
    expect(coarse).toMatch(/\[data-guest-row\] \[data-slot="format-row"\] :is\(button, input\) \{\s*min-width: 44px;\s*min-height: 44px;/);
    expect(css).toMatch(/\[data-guest-document="view"\] \.te-rail \{\s*display: none;/);
  });
});
