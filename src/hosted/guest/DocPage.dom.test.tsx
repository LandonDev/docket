// @vitest-environment jsdom
/**
 * A document on the guest's page (docs/agents/work-docs.md "Styling: the
 * format row", work-guests.md "The page"): an Edit link has the format row in
 * a place of its own, the page's first row under the header, held while the
 * text scrolls; Comment and View have none. The page says the file's name
 * once, in its header, and a View link's page has no comments margin to
 * widen it. A styled document opens as sheets on a page of 640px or more and
 * in Flow under it (docs/DESIGN.md "Work editors: Document pages"). The editor
 * is a stand-in: it has its own tests.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** `(min-width: Npx)` answered from the window's width as it stands, and told again by `resize`. */
const queries = new Set<{ query: string; on(): void }>();
const wideEnough = (query: string) => window.innerWidth >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity);
window.matchMedia = ((query: string) => {
  const entry = { query, on: () => {} };
  return {
    media: query,
    get matches() {
      return wideEnough(query);
    },
    addEventListener: (_: string, on: () => void) => ((entry.on = on), queries.add(entry)),
    removeEventListener: () => queries.delete(entry),
  };
}) as unknown as typeof window.matchMedia;
const resize = (width: number) =>
  act(() => {
    window.innerWidth = width;
    for (const entry of [...queries]) entry.on();
  });

const editors = vi.hoisted(() => [] as Record<string, unknown>[]);
const given = vi.hoisted(() => ({ adapters: null as unknown }));
vi.mock("work-kit/editor", async (original) => {
  const real = await original<typeof import("work-kit/editor")>();
  return {
    ...real,
    // The stand-in reads the adapters the page handed down, as the editor would.
    DocumentEditor: (props: Record<string, unknown>) => {
      given.adapters = real.useEditorAdapters();
      editors.push(props);
      return <div data-fake-editor />;
    },
  };
});
const pageAdapters = () => given.adapters as { collab?: { offline?: string | false }; identity?: { me?: { id: string; name: string } } };

const revoked = vi.hoisted(() => [] as (() => void)[]);
/** What each page asked of its socket (ending.ts `SocketWatch`): a test tells it what the host's socket would. */
const watches = vi.hoisted(() => [] as { revoked(): void; quiet?(q: boolean): void; tooBig?(): void; refusedCopy?(): void; tooMuch?(): void; full?(): void }[]);
vi.mock("./ending", async (real) => ({ ...(await real<typeof import("./ending")>()), watchedSocket: (watch: (typeof watches)[number]) => (watches.push(watch), revoked.push(watch.revoked), class {}) }));
const wiped = vi.hoisted(() => [] as string[]);
vi.mock("./offline", async (real) => ({ ...(await real<typeof import("./offline")>()), wipeOffline: async (link: string, doc?: string) => void wiped.push(`${link}:${doc}`) }));

const { DocPage, FULL_WORDS, OFFLINE_WORDS, TOO_BIG_WORDS, TOO_MUCH_WORDS } = await import("./DocPage");
const { OpenFailed } = await import("./session");
import type { Opened, Session } from "./session";

const WIDTH = window.innerWidth;
afterEach(() => {
  cleanup();
  editors.length = 0;
  watches.length = 0;
  wiped.length = 0;
  window.innerWidth = WIDTH;
});

const sessionOf = (mode: Session["mode"]) => ({ mode, socketUrl: () => "ws://127.0.0.1:1/g/ws/L1", refresh: async () => ({ token: "t", tokenExp: 0 }), post: async () => ({}) }) as unknown as Session;
const session = sessionOf({ kind: "guest", id: "L1", secret: "s" });
const opened = (role: Opened["role"]): Opened => ({ kind: "doc", role, title: "Run of show", expiresAt: 0, me: "guest:L1", name: "Dana Lee", doc: "kdocrun" }) as Opened;
const show = (role: Opened["role"], on = session) => render(<main><DocPage session={on} opened={opened(role)} scheme="light" onGone={() => {}} /></main>);
const at = (width: number, role: Opened["role"] = "edit") => ((window.innerWidth = width), show(role));
type Fake = { view: string; zoom: unknown; threadMargin: unknown; onView(view: string): void; onZoom(zoom: unknown): void; onPage(page: object | null): void; onEditor(editor: object | null): void };
const editor = (): Fake => editors.at(-1) as unknown as Fake;
/** The editor has read the document: it says the document's page (null for a classic one), then hands itself over. */
const read = (page: object | null) =>
  act(() => {
    editor().onPage(page);
    editor().onEditor({});
  });

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

  it("shows its own Comment to a guest who may comment, and never to the owner, whose comments are made in TempCode", () => {
    show("comment");
    expect(editors.at(-1)).toMatchObject({ canComment: true });
    cleanup();
    show("edit", sessionOf({ kind: "owner", ticket: null }));
    expect(editors.at(-1)).toMatchObject({ canComment: false, editable: true });
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

  it("draws no Flow | Pages switch under 640px, and keeps More whole beside it from there", () => {
    const css = readFileSync(join(__dirname, "guest.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 639\.98px\) \{\s*\[data-guest-row\] \[data-format-end="view"\] \{\s*display: none;/);
    const coarse = css.slice(css.indexOf("@media (pointer: coarse)"), css.indexOf("@media (max-width: 639.98px)"));
    // The row's empty stretch lies over More's last 16px: a tap there must be More's.
    expect(coarse).toMatch(/\[data-slot="format-row"\] > span\[aria-hidden\] \{\s*pointer-events: none;/);
    expect(coarse).toMatch(/\[data-format-end="view"\]:not\(\[data-full\]\) \[role="radio"\] \{\s*min-width: 40px;/);
    // The switch's track is as tall as a finger's target, its halves inside it.
    expect(coarse).toMatch(/\[data-guest-row\] \[data-slot="format-segment"\] \{\s*height: 44px;/);
    expect(coarse).toMatch(/\[data-slot="format-segment"\] \[role="radio"\] \{\s*min-height: 40px;/);
  });

  it("opens a styled document in Flow under 640px and as sheets from 640px, fitted to the width until a sheet stands at true size", () => {
    for (const [width, view, zoom] of [[390, "flow", "width"], [639, "flow", "width"], [640, "pages", "width"], [768, "pages", "width"], [864, "pages", 100]] as const) {
      at(width);
      read({});
      expect(editor()).toMatchObject({ view, zoom, title: "Run of show" });
      cleanup();
    }
  });

  it("opens Comment and View links by the same width", () => {
    for (const role of ["comment", "view"] as const) {
      at(768, role);
      read({});
      expect(editor().view).toBe("pages");
      cleanup();
      at(390, role);
      read({});
      expect(editor().view).toBe("flow");
      cleanup();
    }
  });

  it("keeps a document that was classic when it opened in Flow when he styles it, until he picks Pages", () => {
    at(1024);
    read(null);
    expect(editor().view).toBe("flow");
    act(() => editor().onPage({}));
    expect(editor().view).toBe("flow");
    act(() => editor().onView("pages"));
    expect(editor().view).toBe("pages");
  });

  it("lets his own switch and zoom win, and a later resize change nothing", () => {
    at(768);
    read({});
    act(() => editor().onView("flow"));
    expect(editor()).toMatchObject({ view: "flow", zoom: "width" });
    act(() => editor().onZoom(125));
    act(() => editor().onView("pages"));
    expect(editor()).toMatchObject({ view: "pages", zoom: 125 });
    cleanup();
    at(390);
    read({});
    resize(1024);
    expect(editor().view).toBe("flow");
  });

  it("is Flow under 640px whatever was picked, and his pick again once there is room", () => {
    at(768);
    read({});
    expect(editor().view).toBe("pages");
    resize(500);
    expect(editor().view).toBe("flow");
    resize(900);
    expect(editor().view).toBe("pages");
    // A phone turned on its side: he may pick Pages there, and upright it is Flow again.
    cleanup();
    at(390);
    read({});
    resize(844);
    act(() => editor().onView("pages"));
    expect(editor().view).toBe("pages");
    resize(390);
    expect(editor().view).toBe("flow");
  });

  it("opens a comment at its words on sheets, and in the margin's place in Flow", () => {
    at(768, "comment");
    read({});
    expect(editor().threadMargin).toBeUndefined();
    act(() => editor().onView("flow"));
    expect(editor().threadMargin).toBe("under");
    cleanup();
    // A classic document is never drawn as sheets, whatever the width asks for.
    at(768, "comment");
    read(null);
    expect(editor().threadMargin).toBe("under");
  });

  it("gives the column's measure and padding up to the sheets' stage", () => {
    const view = at(768);
    const column = view.container.querySelector<HTMLElement>("[data-guest-document]")!;
    expect(column.className.split(" ")).toEqual(expect.arrayContaining(["max-w-(--doc-column)", "has-[.te-pages-stage]:max-w-none", "has-[.te-pages-stage]:p-0"]));
    expect(column.style.getPropertyValue("--doc-column")).toBe("736px");
    // No inline measure: one would win over the stage's rule.
    expect(column.style.maxWidth).toBe("");
  });
});

describe("a link revoked while its page is open", () => {
  it("ends the page at once for every role when the host closes the socket and the service says the link is gone; a refusal in passing keeps it", async () => {
    for (const role of ["edit", "comment", "view"] as const) {
      revoked.length = 0;
      let gone = 0;
      let answer: Error = new OpenFailed("gone");
      const on = { ...session, refresh: async () => Promise.reject(answer) } as unknown as Session;
      render(<main><DocPage session={on} opened={opened(role)} scheme="light" onGone={() => void gone++} /></main>);
      answer = new Error("offline");
      revoked.at(-1)!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(gone).toBe(0);
      answer = new OpenFailed("gone");
      revoked.at(-1)!();
      await waitFor(() => expect(gone).toBe(1));
      cleanup();
    }
  });
});

describe("words typed while the line is down", () => {
  const collab = () => (editors.at(-1) as unknown as { onStatus(s: object | null): void; onPresence?: unknown; onEditor(e: object): void });

  it("an Edit link keeps a copy on the guest's device, by its link; a reader's page and the owner's keep none", () => {
    show("edit");
    expect(pageAdapters().collab?.offline).toBe("tempcode-guest:L1");
    cleanup();
    show("comment");
    expect(pageAdapters().collab?.offline).toBe(false);
    cleanup();
    show("view");
    expect(pageAdapters().collab?.offline).toBe(false);
    cleanup();
    show("edit", sessionOf({ kind: "owner", ticket: null }));
    expect(pageAdapters().collab?.offline).toBe(false);
  });

  it("says within the line's own words that edits are kept on this device, once the host has been quiet two seconds; the host's next word takes the line away", () => {
    const view = show("edit");
    const status = () => view.container.querySelector("[data-guest-status]");
    expect(status()).toBeNull();
    act(() => watches.at(-1)!.quiet!(true));
    expect(status()!.textContent).toBe(OFFLINE_WORDS.device);
    expect(status()!.getAttribute("role")).toBe("status");
    act(() => watches.at(-1)!.quiet!(false));
    expect(status()).toBeNull();
    // The browser's own word that it is offline says it at once.
    act(() => void window.dispatchEvent(new Event("offline")));
    expect(status()!.textContent).toBe(OFFLINE_WORDS.device);
  });

  it("says what is true of each page: a reader has nothing to keep, and the owner's page keeps his edits in its tab", () => {
    const reader = show("view");
    act(() => void window.dispatchEvent(new Event("offline")));
    expect(reader.container.querySelector("[data-guest-status]")!.textContent).toBe(OFFLINE_WORDS.reader);
    cleanup();
    const own = show("edit", sessionOf({ kind: "owner", ticket: null }));
    act(() => watches.at(-1)!.quiet!(true));
    expect(own.container.querySelector("[data-guest-status]")!.textContent).toBe(OFFLINE_WORDS.tab);
  });

  it("puts the editor's own offline trouble in the same words, and any other trouble in the editor's", () => {
    const view = show("edit");
    act(() => collab().onStatus({ kind: "offline", message: "Offline. Edits stay on this device until the connection is back.", retry: null }));
    expect(view.container.querySelector("[data-guest-status]")!.textContent).toBe(OFFLINE_WORDS.device);
    act(() => collab().onStatus({ kind: "refused", message: "This document could not be opened for editing.", retry: () => {} }));
    expect(view.container.querySelector("[data-guest-status]")!.textContent).toBe("This document could not be opened for editing.Retry");
  });

  it("an update the host cut as too large is said once with Reload, the copy that holds it wiped and the editor gone: nothing sends it again", async () => {
    const view = show("edit");
    act(() => watches.at(-1)!.tooBig!());
    await waitFor(() => expect(view.container.querySelector("[role=alert]")).not.toBeNull());
    expect(view.container.querySelector("[role=alert]")!.textContent).toBe(`${TOO_BIG_WORDS}Reload`);
    expect(wiped).toEqual(["L1:kdocrun"]);
    expect(view.container.querySelector("[data-fake-editor]")).toBeNull();
    expect(view.container.querySelector("[data-guest-row]")).toBeNull();
  });

  it("a link that sent more than its budget is told its edits are kept and go in a minute; the host's next word takes the line away", () => {
    const view = show("edit");
    act(() => watches.at(-1)!.tooMuch!());
    expect(view.container.querySelector("[data-guest-status]")!.textContent).toBe(TOO_MUCH_WORDS);
    // The editor stays: nothing typed is lost, and the page comes back by itself.
    expect(view.container.querySelector("[data-fake-editor]")).not.toBeNull();
    act(() => watches.at(-1)!.quiet!(false));
    expect(view.container.querySelector("[data-guest-status]")).toBeNull();
  });

  it("a document as large as a guest may make it says so once with Reload, and the edit that did not go is not kept to be sent again", async () => {
    const view = show("edit");
    act(() => watches.at(-1)!.full!());
    await waitFor(() => expect(view.container.querySelector("[role=alert]")).not.toBeNull());
    expect(view.container.querySelector("[role=alert]")!.textContent).toBe(`${FULL_WORDS}Reload`);
    expect(wiped).toEqual(["L1:kdocrun"]);
    expect(view.container.querySelector("[data-fake-editor]")).toBeNull();
  });

  it("a copy the host refuses is wiped and the page read afresh, once: a second refusal ends as any revoked close does", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    sessionStorage.clear();
    show("edit");
    act(() => watches.at(-1)!.refusedCopy!());
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(wiped).toEqual(["L1:kdocrun"]);
    // The same tab, after that reload: no second wipe, no loop (the link still stands as it was, so the socket just comes back).
    cleanup();
    show("edit", { ...session, refresh: async () => ({ role: "edit", token: "t", tokenExp: 0 }) } as unknown as Session);
    act(() => watches.at(-1)!.refusedCopy!());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(wiped).toHaveLength(1);
    // A reader's page keeps no copy to refuse.
    cleanup();
    show("view");
    expect(watches.at(-1)!.refusedCopy).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("tells the page's line who else is in the document, and the owner's page says his own name", () => {
    const people: unknown[] = [];
    render(<main><DocPage session={session} opened={opened("edit")} scheme="light" onGone={() => {}} onPeople={(p) => people.push(p)} /></main>);
    const tell = (editors.at(-1) as unknown as { onPresence(p: unknown[]): void }).onPresence;
    tell([{ id: "owner", name: "Landon Hale", avatarUrl: null, color: "#3b82f6" }]);
    expect(people).toEqual([[{ id: "owner", name: "Landon Hale", avatarUrl: null, color: "#3b82f6" }]]);
    cleanup();
    render(<main><DocPage session={sessionOf({ kind: "owner", ticket: null })} opened={{ ...opened("edit"), name: undefined, me: "owner", self: "Landon Hale" } as Opened} scheme="light" onGone={() => {}} /></main>);
    expect(pageAdapters().identity?.me).toMatchObject({ id: "owner", name: "Landon Hale" });
  });

  it("after a reload the caret is back in the text at its start; a first open leaves it where the reader's eye is", () => {
    const made = { focus: vi.fn(), setTextCursorPosition: vi.fn(), document: [{ id: "b1" }] };
    const nav = vi.spyOn(performance, "getEntriesByType");
    nav.mockReturnValue([{ type: "navigate" } as unknown as PerformanceEntry]);
    show("edit");
    act(() => collab().onEditor(made));
    expect(made.focus).not.toHaveBeenCalled();
    cleanup();
    nav.mockReturnValue([{ type: "reload" } as unknown as PerformanceEntry]);
    show("edit");
    act(() => collab().onEditor(made));
    expect(made.setTextCursorPosition).toHaveBeenCalledWith({ id: "b1" }, "start");
    expect(made.focus).toHaveBeenCalledTimes(1);
    // A reader has no caret to put back.
    cleanup();
    show("view");
    act(() => collab().onEditor(made));
    expect(made.focus).toHaveBeenCalledTimes(1);
    nav.mockRestore();
  });

  it("gives every comment control a finger's 44px around it under 640px, drawn as it was", () => {
    const css = readFileSync(join(__dirname, "guest.css"), "utf8");
    const narrow = css.slice(css.lastIndexOf("@media (max-width: 639.98px)"));
    expect(narrow).toMatch(/\.te-card, \.te-margin, \.te-threads-foot\), \.te-threads-popover\) button::after \{\s*content: "";\s*position: absolute;\s*inset-block: min\(0px, calc\(\(100% - 44px\) \/ 2\)\);\s*inset-inline: min\(0px, calc\(\(100% - 44px\) \/ 2\)\);/);
  });
});
