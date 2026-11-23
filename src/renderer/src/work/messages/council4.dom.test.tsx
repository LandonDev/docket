// @vitest-environment jsdom
/**
 * What the council's fourth round asked of the Messages view, one behaviour a test, over the
 * fixtures' seam. All of it is state that outlives a mount or a request: one reader across the
 * 640px split; a draft pressed or discarded that never comes back; a held reply whose press failed;
 * Undo judged when it settles; Mark unread held from the command; the keys' index in a list that
 * loses its open row; the way back into a search taken once; Discard by the field's revision; and
 * the smaller lines.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatRow } from "@shared/work/messages";
import { MessagesDataProvider } from "./data";
import { CHATS, fixtureData, HELD_DRAFT, JOB, MESSAGES, NOW, type FixtureOptions } from "./fixtures";
import { cutToFit } from "./model";
import { MessagesScreen } from "./MessagesView";
import { endVisit, heldUnread, keepPlace, pageOf, patchPage, peekReturn, resetPages, typedFromDraft, visitPlaceOf } from "./page";
import { StartThreadProvider } from "./threads";

vi.mock("work-kit/mail/lib/bytes", () => ({ loadBytes: async () => new Blob(["x"], { type: "image/png" }) }));
vi.mock("../shell/open", () => ({ openConnections: () => {} }));
vi.mock("../../components/ui/toaster", async (original) => ({ ...(await original<object>()), loadToast: async () => Object.assign(() => {}, { error: () => {} }) }));

beforeAll(() => {
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
  URL.createObjectURL = () => "blob:picture";
  URL.revokeObjectURL = () => {};
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => resetPages());
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
const flush = () => act(async () => {});
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const enter = () => fireEvent.keyDown(field(), { key: "Enter" });
const inComposer = (name: string) => within(composer()).queryByRole("button", { name });
const search = (words: string) => fireEvent.change(screen.getByRole("searchbox"), { target: { value: words } });

describe("one reader across the 640px split", () => {
  it("keeps the column, the composer and his focus when the view crosses the line", async () => {
    const { data, view } = mount({}, "c_dana");
    await flush();
    const column = document.querySelector("[data-column]");
    const box = field();
    box.focus();
    type("Half a thought");
    view.rerender(screenOf(data, true));
    await flush();
    expect(document.querySelector("[data-column]")).toBe(column);
    expect(field()).toBe(box);
    expect(document.activeElement).toBe(box);
    view.rerender(screenOf(data, false));
    await flush();
    expect(field()).toBe(box);
    expect(field().value).toBe("Half a thought");
  });

  it("keeps the list mounted but hidden under a narrow conversation, and gives Back the keys on opening", () => {
    mount({}, null, true);
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Conversations" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Conversations" }), { key: "Enter" });
    expect(document.querySelector("[data-messages-list]")!.hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to Messages" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    expect(document.querySelector("[data-messages-pane]")!.hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Conversations" }));
  });

  it("puts a reader remounted by Retry where he stood this visit, ahead of New", async () => {
    // Sixty lines a minute apart, Dana's and his in turn, newest first; he last read the conversation forty lines up.
    const long: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
      _id: `d${i}`,
      who: i % 2 ? { name: "Dana Lee", me: false, personId: "p_dana" } : { name: "Alex Kim", me: true },
      text: `Line ${i} of a long morning's talk about the launcher build.`,
      sentAt: NOW - (60 - i) * 60_000,
      files: [],
    })).reverse();
    const chats: ChatRow[] = CHATS.map((c) => (c._id === "c_dana" ? { ...c, unread: true, readAt: long[40]!.sentAt, sourceReadAt: undefined, lastOutAt: undefined, lastInAt: long[0]!.sentAt } : c));
    const scroller = () => document.querySelector<HTMLElement>("[data-column]")!;
    // Without a place this visit, it opens over New, well up the column.
    mount({ chats, messages: { ...MESSAGES, c_dana: long } }, "c_dana");
    await flush();
    expect(scroller().scrollTop).toBeLessThan(-100);
    cleanup();
    resetPages();
    // He stood at the foot this visit when the messages failed: Retry puts him back there.
    mount({ chats, messages: { ...MESSAGES, c_dana: long }, fail: { messages: 1 } }, "c_dana");
    keepPlace(WS, "c_dana", null);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(Math.abs(scroller().scrollTop)).toBeLessThan(1);
    expect(visitPlaceOf(WS, "c_dana")).toBeNull();
    endVisit(WS, "c_dana");
    expect(visitPlaceOf(WS, "c_dana")).toBeUndefined();
  });
});

describe("a draft pressed or discarded never comes back", () => {
  it("on the same mount, while the Outbox's list still holds it", async () => {
    const { data } = mount({ lingers: true, drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    enter();
    await flush();
    expect(data.log.pressed).toHaveLength(1);
    expect(composer().textContent).not.toContain("Drafted in");
    expect(inComposer("Discard")).toBeNull();
    expect(field().value).toBe("");
    act(() => data.catchUp());
    expect(composer().textContent).not.toContain("Drafted in");
  });

  it("on a mount made while the press goes: the field stays empty and nothing can send it again", async () => {
    const { data, view } = mount({ slow: true, lingers: true, drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    enter();
    view.unmount();
    render(screenOf(data));
    await act(async () => data.release());
    await flush();
    expect(field().value).toBe("");
    expect(composer().textContent).not.toContain("Drafted in");
    enter();
    expect(data.log.sent).toEqual([]);
    expect(data.log.pressed).toHaveLength(1);
  });

  it("after Discard: the line goes and Use draft is not offered", async () => {
    const { data } = mount({ lingers: true, drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    type("");
    type("Mine");
    await act(async () => fireEvent.click(inComposer("Discard")!));
    expect(data.log.dropped).toEqual([HELD_DRAFT.id]);
    expect(composer().textContent).not.toContain("Drafted in");
    expect(inComposer("Use draft")).toBeNull();
    expect(field().value).toBe("Mine");
  });
});

describe("a held reply whose press failed", () => {
  it("says Not sent. with the reason and Open in Outbox, keeps its words out of the field, and his next words go as his own", async () => {
    const { data } = mount({ lingers: true, pressFails: "Slack said the thread is archived", drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    enter();
    await flush();
    const line = document.querySelector<HTMLElement>("[data-draft-failed]")!;
    expect(line.textContent).toContain("Not sent.");
    expect(line.textContent).toContain("Slack said the thread is archived");
    expect(field().value).toBe("");
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
    expect(inComposer("Discard")).toBeNull();
    expect(inComposer("Use draft")).toBeNull();
    fireEvent.click(within(line).getByRole("button", { name: "Open in Outbox" }));
    expect(data.log.outbox).toEqual([`box:host:${HELD_DRAFT.id}`]);
    act(() => data.catchUp());
    type("I'll send it by hand");
    enter();
    await flush();
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: "I'll send it by hand" }]);
    expect(data.log.pressed).toHaveLength(1);
  });

  it("never fills the field with a failed item's words on a new mount", () => {
    mount({ drafts: { c_dana: [{ ...HELD_DRAFT, failed: "It couldn't be sent" }] } }, "c_dana");
    expect(field().value).toBe("");
    expect(document.querySelector("[data-draft-failed]")).not.toBeNull();
  });
});

describe("Undo judged when it settles", () => {
  it("saves an edit made to the draft while the Undo went, then puts his words back as his own", async () => {
    const { data } = mount({ slowUndo: true, drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    type("");
    type("My reply");
    enter();
    await flush();
    await act(async () => fireEvent.click(inComposer("Use draft")!));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    type(`${HELD_DRAFT.text} Edited while it went.`);
    await act(async () => data.release());
    await flush();
    expect(data.log.saved).toEqual([{ id: HELD_DRAFT.id, text: `${HELD_DRAFT.text} Edited while it went.` }]);
    expect(field().value).toBe("My reply");
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
  });
});

describe("Mark unread held from the command", () => {
  async function markUnread() {
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Mark unread" })));
  }

  it("holds across the crossing before LifeOS's answer shows", async () => {
    const { data, view } = mount({ unreadLater: true }, "c_dana");
    expect(data.log.read).toEqual(["c_dana"]);
    await markUnread();
    expect(heldUnread(WS, "c_dana")).not.toBeUndefined();
    view.rerender(screenOf(data, true));
    act(() => data.catchUp());
    await flush();
    view.rerender(screenOf(data, false));
    await flush();
    expect(data.log.read).toEqual(["c_dana"]);
  });

  it("lets the hold go when LifeOS refuses the mark", async () => {
    mount({ unreadFails: true }, "c_dana");
    await markUnread();
    expect(heldUnread(WS, "c_dana")).toBeUndefined();
  });
});

describe("the keys in a list that loses its open row", () => {
  it("move from the departed row's index, and the menu key opens the row now there", async () => {
    const unread = new Set(["c_builds", "c_dana", "c_trio"]);
    const chats: ChatRow[] = CHATS.map((c) => ({ ...c, unread: unread.has(c._id) }));
    const { data } = mount({ chats });
    act(() => patchPage(WS, { filter: "unread" }));
    const list = () => screen.getByRole("listbox", { name: "Conversations" });
    fireEvent.click(within(list()).getAllByRole("option")[1]!);
    await flush();
    // Read on opening, Dana's conversation leaves the Unread list; the keys stand at its index.
    expect(within(list()).getAllByRole("option").map((o) => o.id)).toEqual(["chat-row-c_builds", "chat-row-c_trio"]);
    fireEvent.keyDown(list(), { key: "F10", shiftKey: true });
    await flush();
    expect(await screen.findByRole("menuitem", { name: "Mark read" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(pageOf(WS).chatId).toBe("c_trio");
    expect(data.log.read).toContain("c_trio");
  });
});

describe("the way back into a search", () => {
  function openHitAtNarrow(words: string) {
    search(words);
    const results = screen.getByRole("listbox", { name: "Search results" });
    fireEvent.keyDown(results, { key: "ArrowDown" });
    fireEvent.keyDown(results, { key: "Enter" });
  }

  it("is taken once: typing words with no match afterwards leaves the keys in the search field", () => {
    mount({}, null, true);
    openHitAtNarrow("controller");
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Search results" }));
    const box = screen.getByRole("searchbox");
    box.focus();
    search("zebra crossing");
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(document.activeElement).toBe(box);
  });

  it("on a failed search gives Retry the keys and keeps the way back for the search Retry brings", () => {
    mount({ searchFails: ["broken words"] }, null, true);
    openHitAtNarrow("controller");
    act(() => patchPage(WS, { query: "broken words" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
    expect(peekReturn(WS)).not.toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
    act(() => patchPage(WS, { query: "controller" }));
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Search results" }));
    expect(peekReturn(WS)).toBeUndefined();
  });

  it("Clear search hands the keys to the search field, Clear filter to the list", () => {
    mount();
    search("zebra crossing");
    fireEvent.click(within(screen.getByText("No matches").closest("[data-slot='empty']")!).getByRole("button", { name: "Clear search" }));
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    cleanup();
    resetPages();
    mount({ chats: CHATS.map((c) => ({ ...c, unread: false })) });
    act(() => patchPage(WS, { filter: "unread" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Conversations" }));
  });
});

describe("Discard by the field's revision", () => {
  it("leaves the same words typed again as his own while Discard went", async () => {
    const { data } = mount({ slowDrop: true, drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    fireEvent.click(inComposer("Discard")!);
    type("");
    type(HELD_DRAFT.text);
    await act(async () => data.release());
    await flush();
    expect(field().value).toBe(HELD_DRAFT.text);
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
  });
});

describe("the draft line's controls", () => {
  it("stand at the line's far end, apart from the thread's name, still in ink", () => {
    mount({ drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    type("");
    type("Mine");
    const use = inComposer("Use draft")!;
    expect(use.className).toContain("ms-auto");
    expect(use.className).not.toContain("text-muted-foreground");
    expect(use.parentElement!.className).toContain("flex-1");
  });
});

describe("a hit's line measured in its own font", () => {
  it("cuts only when the words through the match do not fit, and never cuts the match", () => {
    const fits = (room: number) => (line: string) => line.length <= room;
    const text = "I'll take the controller bug, no worries.";
    expect(cutToFit(text, "controller", fits(30))).toBe(text);
    expect(cutToFit(text, "controller", fits(20))).toBe("…take the controller bug, no worries.");
    expect(cutToFit("https://example.com/releases/nightly/controller", "controller", fits(16))).toBe("…htly/controller");
    expect(cutToFit(text, "controller", fits(5))).toBe("…controller bug, no worries.");
  });

  it("keeps a lead that fits at the 260px sash minimum, measured on a canvas", () => {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return { font: "", measureText: (s: string) => ({ width: s.length * 5.5 }) };
        }
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(260);
    mount();
    search("controller");
    const lines = within(screen.getByRole("listbox", { name: "Search results" })).getAllByRole("option").map((o) => o.lastElementChild!.textContent!);
    // 182px of line at about 5.8px a character: "You: I'll take the controller" (29) fits, so it is not cut, where counting
    // characters at 6.4px each cut it.
    expect(lines.some((line) => line.startsWith("You: I'll take the controller"))).toBe(true);
    expect(lines.every((line) => line.includes("controller") || line.includes("Controller"))).toBe(true);
    vi.unstubAllGlobals();
  });
});
