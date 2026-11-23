// @vitest-environment jsdom
/**
 * What the council's third round asked of the Messages view, one behaviour a test, over the
 * fixtures' seam: a Send that empties the field at the press and goes once, on any mount; Undo
 * that keeps his words apart from a thread's draft; Discard of an edited draft; the route that
 * chooses the button; the read mark that waits for a wanted message; his unread mark across the
 * 640px crossing; Back to a hit in view; the sizes the column watches; and the smaller lines.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRow } from "@shared/work/messages";
import { MessagesDataProvider } from "./data";
import { CHATS, FILE_FAILED, fixtureData, HELD_DRAFT, JOB, manyMessages, MESSAGES, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { patchPage, pendingPress, resetPages, typedFromDraft, wantMessage } from "./page";
import { StartThreadProvider } from "./threads";

vi.mock("work-kit/mail/lib/bytes", () => ({ loadBytes: async () => new Blob(["x"], { type: "image/png" }) }));
vi.mock("../shell/open", () => ({ openConnections: () => {} }));
vi.mock("../../components/ui/toaster", async (original) => ({ ...(await original<object>()), loadToast: async () => Object.assign(() => {}, { error: () => {} }) }));

/** Every ResizeObserver the view makes, with what it watches, so a test can say a size changed. */
const observers: { callback: ResizeObserverCallback; watched: Set<Element> }[] = [];
beforeAll(() => {
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
  globalThis.ResizeObserver = class {
    entry: { callback: ResizeObserverCallback; watched: Set<Element> };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, watched: new Set() };
      observers.push(this.entry);
    }
    observe(el: Element) {
      this.entry.watched.add(el);
    }
    unobserve(el: Element) {
      this.entry.watched.delete(el);
    }
    disconnect() {
      this.entry.watched.clear();
    }
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
  URL.createObjectURL = () => "blob:picture";
  URL.revokeObjectURL = () => {};
});
beforeEach(() => {
  resetPages();
  observers.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WS = "ws";
function screenOf(data: ReturnType<typeof fixtureData>, narrow = false) {
  return (
    <MessagesDataProvider value={data}>
      <StartThreadProvider value={() => {}}>
        <MessagesScreen workspaceId={WS} job={JOB} narrow={narrow} />
      </StartThreadProvider>
    </MessagesDataProvider>
  );
}
function mount(options: FixtureOptions = {}, chatId: string | null = null, narrow = false) {
  const data = fixtureData(options);
  patchPage(WS, { chatId });
  const view = render(screenOf(data, narrow));
  return { data, view };
}
const field = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
const composer = (): HTMLElement => document.querySelector<HTMLElement>("[data-composer]")!;
const block = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-block="${id}"]`)!;
const button = (name: string): HTMLButtonElement => within(composer()).getByRole<HTMLButtonElement>("button", { name });
const flush = () => act(async () => {});
const press = async (name: string) => act(async () => fireEvent.click(button(name)));
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const enter = () => fireEvent.keyDown(field(), { key: "Enter" });

describe("Send empties the field at the press and goes once", () => {
  it("keeps only what he typed while it went, and a second Return sends nothing more", async () => {
    const { data } = mount({ slow: true }, "c_dana");
    type("Yes");
    enter();
    expect(field().value).toBe("");
    type("and the build");
    enter();
    fireEvent.click(button("Send"));
    await act(async () => data.release());
    await flush();
    expect(field().value).toBe("and the build");
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: "Yes" }]);
    expect(pendingPress(WS, "c_dana")).toBeUndefined();
  });

  it("cannot send again from a new mount while the press is pending", async () => {
    const { data, view } = mount({ slow: true }, "c_dana");
    type("Yes");
    enter();
    view.unmount();
    render(screenOf(data));
    expect(field().value).toBe("");
    type("Yes");
    enter();
    expect(button("Send").disabled).toBe(true);
    await act(async () => data.release());
    await flush();
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: "Yes" }]);
    // Answered, the press is dropped and the next Send goes.
    expect(button("Send").disabled).toBe(false);
  });

  it("puts the pressed words back in front of what he typed since, with the refusal", async () => {
    const { data } = mount({ slow: true, refuse: "Slack did not take it" }, "c_dana");
    type("Yes");
    enter();
    type("and the build");
    await act(async () => data.release());
    await flush();
    expect(field().value).toBe("Yes\nand the build");
    expect(within(composer()).getByRole("alert").textContent).toBe("Slack did not take it");
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
  });

  // Round 9: a held draft's words stay in the field until the host has taken them; refused, the field is as it was.
  it("keeps a held draft's words in the field, read only, while its press goes, and leaves them as they were when it is refused", async () => {
    const { data } = mount({ slow: true, refuse: "The Outbox did not send it", drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    enter();
    expect(field().value).toBe(HELD_DRAFT.text);
    expect(field().readOnly).toBe(true);
    // The line still names the draft's thread while its words are on screen.
    expect(composer().textContent).toContain("Drafted in");
    await act(async () => data.release());
    await flush();
    expect(field().value).toBe(HELD_DRAFT.text);
    expect(field().readOnly).toBe(false);
    expect(typedFromDraft(WS, "c_dana")).toBe(HELD_DRAFT.id);
    expect(within(composer()).getByRole("alert").textContent).toBe("The Outbox did not send it");
    expect(data.log.pressed).toEqual([]);
  });
});

describe("Undo with a thread's draft in the field", () => {
  async function sendThenUseDraft(options: FixtureOptions = {}) {
    const { data } = mount({ drafts: { c_dana: [HELD_DRAFT] }, ...options }, "c_dana");
    type("");
    type("My reply");
    await press("Send");
    await act(async () => fireEvent.click(within(composer()).getByRole("button", { name: "Use draft" })));
    expect(typedFromDraft(WS, "c_dana")).toBe(HELD_DRAFT.id);
    return data;
  }

  it("saves an edited draft to its held item, then takes his undone words as his own", async () => {
    const data = await sendThenUseDraft();
    type(`${HELD_DRAFT.text} Edited.`);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await flush();
    expect(data.log.saved).toEqual([{ id: HELD_DRAFT.id, text: `${HELD_DRAFT.text} Edited.` }]);
    expect(field().value).toBe("My reply");
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
    expect(within(composer()).getByRole("button", { name: "Use draft" })).toBeTruthy();
    await press("Send");
    expect(data.log.pressed).toEqual([]);
    expect(data.log.sent.map((s) => s.text)).toEqual(["My reply", "My reply"]);
  });

  it("leaves an unedited draft waiting and saves nothing", async () => {
    const data = await sendThenUseDraft();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await flush();
    expect(data.log.saved).toEqual([]);
    expect(field().value).toBe("My reply");
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
  });
});

describe("Discard and the route", () => {
  it("empties the field on Discard of a draft he edited", async () => {
    const { data } = mount({ drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    type(`${HELD_DRAFT.text} Edited.`);
    await press("Discard");
    expect(data.log.dropped).toEqual([HELD_DRAFT.id]);
    expect(field().value).toBe("");
  });

  it("copies a held draft where the route says no, with LifeOS's reason on its line, and keeps it", async () => {
    const { data } = mount({ drafts: { c_dana: [HELD_DRAFT] }, routes: { c_dana: { can: false, why: "The Mac that sends iMessage is offline" } } }, "c_dana");
    expect(within(composer()).queryByRole("button", { name: "Send" })).toBeNull();
    expect(composer().textContent).toContain("The Mac that sends iMessage is offline");
    enter();
    await press("Copy");
    expect(data.log.pressed).toEqual([]);
    expect(data.log.dropped).toEqual([]);
    expect(field().value).toBe(HELD_DRAFT.text);
    expect(typedFromDraft(WS, "c_dana")).toBe(HELD_DRAFT.id);
  });

  it("draws Use draft and Open thread in ink", () => {
    mount({ drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    type("");
    type("Mine");
    for (const name of ["Use draft", "Open thread"]) expect(button(name).className).not.toContain("text-muted-foreground");
  });
});

describe("the read mark", () => {
  const unreadLong = (): { chats: ChatRow[]; messages: typeof MESSAGES } => {
    const long = manyMessages("c_dana", 160);
    // New sits inside the first page, so the column opens without paging: only the wanted message sends it further.
    const since = long[10]!.sentAt;
    return { chats: CHATS.map((c) => (c._id === "c_dana" ? { ...c, unread: true, readAt: since, sourceReadAt: undefined, lastOutAt: undefined, lastInAt: long[0]!.sentAt } : c)), messages: { ...MESSAGES, c_dana: long } };
  };

  it("waits for a wanted message past the first page, and writes none when the next page fails", async () => {
    const { chats, messages } = unreadLong();
    wantMessage(WS, "c_dana", messages.c_dana![120]!._id);
    const { data } = mount({ chats, messages, olderFail: true }, "c_dana");
    await flush();
    await flush();
    expect(screen.getByText("The messages did not load")).toBeTruthy();
    expect(data.log.read).toEqual([]);
  });

  it("marks read once the lookup ends without the message and the column opens where it would", async () => {
    const { chats, messages } = unreadLong();
    wantMessage(WS, "c_dana", "never_there");
    const { data } = mount({ chats, messages }, "c_dana");
    for (let i = 0; i < 6; i++) await flush();
    expect(data.log.read).toEqual(["c_dana"]);
  });

  it("keeps his Mark unread across the 640px crossing", async () => {
    const { data, view } = mount({}, "c_dana");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Mark unread" })));
    await flush();
    expect(data.log.read).toEqual(["c_dana"]);
    view.rerender(screenOf(data, true));
    await flush();
    view.rerender(screenOf(data, false));
    await flush();
    expect(data.log.read).toEqual(["c_dana"]);
    // A newer message from someone else lets the mark go.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => data.deliver("c_dana", "Dana Lee", "Any update?"));
    await flush();
    expect(data.log.read).toEqual(["c_dana", "c_dana"]);
  });
});

describe("back at 640", () => {
  it("brings the hit he left into view", () => {
    const seen: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this);
    };
    mount({}, null, true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "controller" } });
    const results = screen.getByRole("listbox", { name: "Search results" });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(results, { key: "ArrowDown" });
    const hit = results.getAttribute("aria-activedescendant")!;
    fireEvent.keyDown(results, { key: "Enter" });
    seen.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    expect(seen.map((el) => el.id)).toEqual([hit]);
  });

  it("gives Clear search the keys when no hit is left", () => {
    mount({}, null, true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "controller" } });
    const results = screen.getByRole("listbox", { name: "Search results" });
    fireEvent.keyDown(results, { key: "ArrowDown" });
    fireEvent.keyDown(results, { key: "Enter" });
    act(() => patchPage(WS, { query: "zebra crossing" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    expect(screen.getByText("No matches")).toBeTruthy();
    const action = screen.getByText("No matches").closest("[data-slot='empty']")!.querySelector("button");
    expect(action?.textContent).toBe("Clear search");
    expect(document.activeElement).toBe(action);
  });
});

describe("sizes the column watches", () => {
  it("watches the viewport and the drawn blocks, and draws again when a block's size changes under it", async () => {
    mount({}, "c_dana");
    await flush();
    const scroller = document.querySelector<HTMLElement>("[data-column]")!;
    const watcher = observers.find((o) => o.watched.has(scroller))!;
    expect(watcher).toBeTruthy();
    expect(watcher.watched.has(block("c_dana_m8"))).toBe(true);
    // A picture fell to its failure line: one block is a new height. The draw that follows measures every drawn block.
    const reads = new Map<Element, number>();
    const heights = new Map<Element, number>([[block("c_dana_m8"), 140]]);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      reads.set(this, (reads.get(this) ?? 0) + 1);
      return heights.get(this) ?? 0;
    });
    await act(async () => watcher.callback([{ target: block("c_dana_m8") } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    expect(reads.get(block("c_dana_m7")) ?? 0).toBeGreaterThan(0);
    // The same size again draws nothing.
    reads.clear();
    await act(async () => watcher.callback([{ target: block("c_dana_m8") } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    expect(reads.get(block("c_dana_m7")) ?? 0).toBe(0);
  });
});

describe("the smaller lines", () => {
  it("names a search's first bones as search results, and the reader's bones as a status", () => {
    mount({ searchPending: "controller" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "controller" } });
    expect(screen.getByRole("status", { name: "Loading search results" })).toBeTruthy();
    cleanup();
    resetPages();
    mount({ messagesLoading: true }, "c_dana");
    expect(screen.getByRole("status", { name: "Loading messages" }).getAttribute("aria-busy")).toBe("true");
  });

  it("gives the name bones widths in pixels that differ row to row", () => {
    mount({ loading: true });
    const widths = [...screen.getByRole("status", { name: "Loading conversations" }).querySelectorAll<HTMLElement>(".h-3")].map((el) => el.style.width);
    expect(widths.slice(0, 3)).toEqual(["120px", "88px", "148px"]);
    expect(new Set(widths).size).toBe(widths.length);
  });

  it("wraps a long unbroken file name inside the message", async () => {
    const long = FILE_FAILED.map((m) => ({ ...m, files: m.files.map((f) => (f.status === "failed" ? { ...f, name: "starboard_final_final_keyart_launcher_build_0_9_6_export.zip" } : f)) }));
    mount({ messages: { ...MESSAGES, c_lucas: long } }, "c_lucas");
    await flush();
    const name = screen.getByText("starboard_final_final_keyart_launcher_build_0_9_6_export.zip");
    expect(name.className).toContain("[overflow-wrap:anywhere]");
    expect(name.className).toContain("min-w-0");
  });

  it("gives the thread replies of the fixtures the id of what they answer", () => {
    const replies = MESSAGES.c_design!.filter((m) => m.replyTo);
    expect(replies.length).toBe(3);
    expect(replies.every((m) => MESSAGES.c_design!.some((parent) => parent._id === m.replyTo!.id))).toBe(true);
  });
});
