// @vitest-environment jsdom
/**
 * The guest's page around a project's link: the line, a document opened in
 * place with the way back, one that leaves the project closed at the page's
 * next read, and a link that ends while a document is open.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestProjection } from "@shared/work/guestProjection";

if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.scrollTo ??= () => {};
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;

const projection = (docs = [{ id: "kdocrun", title: "Run of show" }]): GuestProjection => ({
  project: { id: "kproj1", name: "Spring LAN", status: "active", description: "", docId: null },
  counts: { todo: 1, doing: 0, waiting: 0, done: 0 },
  tasks: [{ id: "ktask1", key: "PUR-1", parentId: null, rank: "a", title: "Book the ballroom", status: "todo", priority: null, dueAt: null, notes: "" }],
  truncated: false,
  docs,
  sheets: [],
});

/** The service: the link's projection now (null: the link is gone), and a listed document's text. */
const service = { now: projection() as GuestProjection | null, text: "Check-in opens at the north doors." };

beforeEach(() => {
  service.now = projection();
  service.text = "Check-in opens at the north doors.";
  window.history.pushState(null, "", `/g/L1#k=${"k".repeat(43)}`);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { table?: string; id?: string };
    const answer = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json }) as Response;
    if (!service.now) return answer(403, { error: "gone" });
    if (new URL(url).pathname.endsWith("/open")) return answer(200, { kind: "project", role: "view", name: "Dana Lee", title: "Spring LAN", owner: "Landon Hale", expiresAt: Date.UTC(2026, 11, 18), me: "guest:L1", projection: service.now });
    if (!service.now.docs.some((d) => d.id === body.id)) return answer(403, { error: "gone" });
    return answer(200, { kind: "doc", role: "view", title: "Run of show", expiresAt: 0, me: "guest:L1", doc: body.id, markdown: service.text });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const { GuestApp } = await import("./GuestApp");
const line = () => document.querySelector("header") as HTMLElement;
// The project's screens are a chunk of their own: the first find waits for it to load.
const first = (words: string) => screen.findByText(words, {}, { timeout: 8000 });

describe("a project's link on the guest's page", () => {
  it("says the project, whose it is, that the guest can view and until when, with the screens' switch in the line", async () => {
    render(<GuestApp />);
    expect(await first("Book the ballroom")).toBeTruthy();
    expect(line().textContent).toMatch(/Spring LAN.*Landon Hale.*Can view.*until/);
    expect(within(line()).getByRole("tab", { name: "Board" })).toBeTruthy();
    expect(within(line()).queryByRole("button", { name: /Back/ })).toBeNull();
    // Under the line the page is the sheets' stage wherever a document is drawn as sheets (DocPage.tsx).
    expect(document.querySelector("main")!.className.split(" ")).toContain("has-[.te-pages-stage]:bg-(--stage)");
  });

  it("opens a document in place as its text, with the way back first in the line", async () => {
    render(<GuestApp />);
    fireEvent.click(await first("Run of show"));
    expect(await screen.findByText("Check-in opens at the north doors.")).toBeTruthy();
    // Text, not an editor: nothing to type in, and the project's own controls are out of the line.
    expect(document.querySelectorAll("[contenteditable='true'], textarea, input")).toHaveLength(0);
    expect(within(line()).queryByRole("tab", { name: "Board" })).toBeNull();
    expect(line().textContent).toMatch(/Run of show.*Landon Hale.*Can view/);
    fireEvent.click(within(line()).getByRole("button", { name: "Back to Spring LAN" }));
    expect(screen.queryByText("Check-in opens at the north doors.")).toBeNull();
    expect((document.querySelector("[data-guest-project]") as HTMLElement).hidden).toBe(false);
  });

  it("closes a document the project no longer lists at its next read, and reads an open one again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<GuestApp />);
    fireEvent.click(await first("Run of show"));
    await screen.findByText("Check-in opens at the north doors.");
    service.text = "Check-in opens at the south doors.";
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(await screen.findByText("Check-in opens at the south doors.")).toBeTruthy();
    service.now = projection([]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    await waitFor(() => expect(document.querySelector("[data-guest-doc]")).toBeNull());
    expect((document.querySelector("[data-guest-project]") as HTMLElement).hidden).toBe(false);
  });

  it("says the link no longer opens anything when it ends while a document is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<GuestApp />);
    fireEvent.click(await first("Run of show"));
    await screen.findByText("Check-in opens at the north doors.");
    service.now = null;
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(await screen.findByText("This link no longer opens anything")).toBeTruthy();
  });

  it("puts a task page's way back first in the line, where a document's is, and Escape goes back from either", async () => {
    render(<GuestApp />);
    fireEvent.click(await first("Book the ballroom"));
    fireEvent.click(await screen.findByRole("button", { name: "Open task" }));
    const back = await within(line()).findByRole("button", { name: "Back to Spring LAN" });
    // First in the line, before the glyph and the project's name; the task's key stays after them.
    expect(line().firstElementChild!.contains(back)).toBe(true);
    expect(line().textContent).toMatch(/Spring LAN.*PUR-1/);
    expect(within(line()).queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(within(line()).queryByRole("button", { name: /Back/ })).toBeNull());
    // A document's way back is in the same place, and Escape leaves it too.
    fireEvent.click(await first("Run of show"));
    await screen.findByText("Check-in opens at the north doors.");
    expect(line().firstElementChild).toBe(within(line()).getByRole("button", { name: "Back to Spring LAN" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Check-in opens at the north doors.")).toBeNull());
    expect((document.querySelector("[data-guest-project]") as HTMLElement).hidden).toBe(false);
  });
});

describe("a face in the project's screens", () => {
  it("wears the image outline, as the guest's own face and the desktop's do", async () => {
    const { Face } = await import("./ProjectPage");
    const { container } = render(<Face name="Dana Lee" size={20} />);
    const face = container.firstElementChild as HTMLElement;
    expect(face.textContent).toBe("DL");
    expect(face.className).toContain("outline-(--image-outline)");
    expect(face.className).toContain("-outline-offset-1");
  });
});
