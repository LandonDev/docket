// @vitest-environment jsdom
/**
 * A project on the guest's page: the shared project screens on the read-only
 * client. What is proven: the page draws the project and no control that
 * writes, leaves comments and history out, asks the service again for what
 * the project shows, opens a document or sheet through a session of its own,
 * and says the link is gone when the service does.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuestProjection } from "@shared/work/guestProjection";
import { Session } from "./session";

if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.scrollTo ??= () => {};

const { ProjectPage } = await import("./ProjectPage");

const projection = (over: Partial<GuestProjection> = {}): GuestProjection => ({
  project: { id: "kproj1", name: "Spring LAN", status: "active", description: "Two days in the Union ballroom.", docId: null },
  counts: { todo: 1, doing: 1, waiting: 0, done: 0 },
  tasks: [
    { id: "ktask1", key: "PUR-1", parentId: null, rank: "a", title: "Book the ballroom", status: "doing", priority: "high", dueAt: null, notes: "Ask Dana." },
    { id: "ktask2", key: "PUR-2", parentId: null, rank: "b", title: "Network for 64 seats", status: "todo", priority: null, dueAt: null, notes: "" },
  ],
  truncated: false,
  docs: [{ id: "kdocrun", title: "Run of show" }],
  sheets: [{ id: "ksheet1", title: "Budget" }],
  ...over,
});

/** The service as the page's session reaches it: `/open` answers the projection now, `/item` a token for a listed thing. */
function service(start: GuestProjection) {
  const state = { now: start as GuestProjection | null, text: "Doors at 9:00 both days.", calls: [] as { path: string; body: Record<string, unknown> }[] };
  const fetchFn = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    state.calls.push({ path, body });
    const answer = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json }) as Response;
    if (!state.now) return answer(403, { error: "gone" });
    if (path.endsWith("/open")) return answer(200, { kind: "project", role: "view", name: "Dana Lee", title: state.now.project.name, owner: "Landon Hale", expiresAt: Date.now() + 1e9, me: "guest:L1", projection: state.now });
    const listed = body.table === "docs" ? state.now.docs.some((d) => d.id === body.id) || state.now.project.docId === body.id : state.now.sheets.some((s) => s.id === body.id);
    if (!listed) return answer(403, { error: "gone" });
    // A document is its text as it stands; a sheet a token for its socket.
    if (body.table === "docs") return answer(200, { kind: "doc", role: "view", title: "x", expiresAt: Date.now() + 1e9, me: "guest:L1", doc: body.id, markdown: state.text });
    return answer(200, { kind: "sheet", role: "view", title: "x", expiresAt: Date.now() + 1e9, token: "t", tokenExp: Date.now() + 6e5, me: "guest:L1", sheet: body.id });
  }) as unknown as typeof fetch;
  const session = new Session({ kind: "guest", id: "L1", secret: "k".repeat(43) }, "https://tempcode.example", { get: () => null, set: () => {} }, fetchFn);
  return { state, session };
}

async function mount(start = projection()) {
  const { state, session } = service(start);
  const opened = await session.refresh();
  const slot = document.createElement("div");
  document.body.append(slot);
  const onOpen = vi.fn();
  const onGone = vi.fn();
  const view = render(<ProjectPage session={session} opened={opened} slot={slot} hidden={false} onOpen={onOpen} onGone={onGone} />);
  return { state, session, slot, onOpen, onGone, view };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("a project on the guest's page", () => {
  it("draws the project, its tasks and its documents, and no control that writes", async () => {
    const { view, slot } = await mount();
    expect(await screen.findByRole("heading", { name: "Spring LAN" })).toBeTruthy();
    expect(screen.getByText("Book the ballroom")).toBeTruthy();
    expect(screen.getByText("Network for 64 seats")).toBeTruthy();
    expect(screen.getByText("Run of show")).toBeTruthy();
    expect(screen.getByText("Budget")).toBeTruthy();
    const page = view.container;
    // Nothing to type in, nothing to tick, no menu of acts, no link out.
    expect(page.querySelectorAll("input, textarea, [contenteditable='true'], [role='textbox'], [role='checkbox'], a[href]")).toHaveLength(0);
    const names = [...page.querySelectorAll("button"), ...slot.querySelectorAll("button")].map((b) => `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`.trim());
    for (const name of names) expect(name).not.toMatch(/new |add|create|delete|rename|comment|thread|share|mark |done|drop|move|actions for/i);
    // Comments and history are the owner's alone: the page has no Activity.
    expect(screen.queryByText("Activity")).toBeNull();
    expect(screen.queryByPlaceholderText(/comment/i)).toBeNull();
    // The line holds the screens' own switch between the list and the board, and no way back to a list of projects.
    expect(slot.querySelector("button")).toBeTruthy();
    expect(slot.textContent).not.toContain("Projects");
  });

  it("opens a task in its peek, read only", async () => {
    await mount();
    fireEvent.click(await screen.findByText("Book the ballroom"));
    expect(await screen.findByText("Ask Dana.")).toBeTruthy();
    expect(document.querySelectorAll("input, textarea, [contenteditable='true'], [role='textbox']")).toHaveLength(0);
  });

  it("opens a document or a sheet where the page asks, by its table and id", async () => {
    const { onOpen } = await mount();
    fireEvent.click(await screen.findByText("Run of show"));
    expect(onOpen).toHaveBeenLastCalledWith({ table: "docs", id: "kdocrun", title: "Run of show" });
    fireEvent.click(screen.getByText("Budget"));
    expect(onOpen).toHaveBeenLastCalledWith({ table: "sheets", id: "ksheet1", title: "Budget" });
  });

  it("shows the description as its document's text, the stored lead until it comes, and reads it again with the project", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state } = await mount(projection({ project: { ...projection().project, docId: "kdesc" } }));
    expect(await screen.findByText("Doors at 9:00 both days.")).toBeTruthy();
    expect(state.calls.find((c) => c.path.endsWith("/item"))?.body).toMatchObject({ table: "docs", id: "kdesc" });
    // No editor and no socket: the text is drawn as words, with nothing to type in.
    expect(document.querySelectorAll("[contenteditable='true'], textarea, input")).toHaveLength(0);
    state.text = "Doors at 8:30 on Sunday.";
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(await screen.findByText("Doors at 8:30 on Sunday.")).toBeTruthy();
  });

  it("asks again for what the project shows, and says the link is gone when the service does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state, onGone } = await mount();
    expect(await screen.findByText("Book the ballroom")).toBeTruthy();
    state.now = projection({ tasks: [{ id: "ktask3", key: "PUR-3", parentId: null, rank: "a", title: "Order the cables", status: "todo", priority: null, dueAt: null, notes: "" }] });
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(await screen.findByText("Order the cables")).toBeTruthy();
    expect(screen.queryByText("Book the ballroom")).toBeNull();
    // Revoked: the next read answers "gone".
    state.now = null;
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    await waitFor(() => expect(onGone).toHaveBeenCalled());
  });
});

describe("a session for a project's document or sheet", () => {
  it("asks the item's route with the link's secret; a document is its text, a sheet names itself in its socket", async () => {
    const { state, session } = service(projection());
    const child = session.child({ table: "docs", id: "kdocrun" });
    const opened = await child.refresh();
    expect(opened).toMatchObject({ kind: "doc", role: "view", doc: "kdocrun", markdown: "Doors at 9:00 both days." });
    expect(opened.token).toBeUndefined();
    expect(state.calls.at(-1)).toEqual({ path: "/g/L1/item", body: { secret: "k".repeat(43), table: "docs", id: "kdocrun" } });
    expect(session.child({ table: "sheets", id: "ksheet1" }).socketUrl(opened)).toBe("wss://tempcode.example/g/ws/L1/sheets/ksheet1");
    // One the project does not list answers as gone.
    await expect(session.child({ table: "docs", id: "kother" }).refresh()).rejects.toMatchObject({ why: "gone" });
    // The link's own socket has no item in it.
    expect(session.socketUrl(opened)).toBe("wss://tempcode.example/g/ws/L1");
  });
});
