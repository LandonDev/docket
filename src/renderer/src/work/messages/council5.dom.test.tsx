// @vitest-environment jsdom
/**
 * What the council's fifth round asked of the Messages view, one behaviour a test, over the
 * fixtures' seam: a held reply that may have gone never reads "Not sent."; the failed line names
 * its thread, says the route's reason under Copy and is a status, and no row marks a failed draft
 * as waiting; Open in Outbox names that very item; the field's origin read against every draft;
 * every async step judged by the field as pressed (Undo across its save, Copy's cleanup); keys
 * handed to a named neighbour when their control goes; a change of the words drops the way back;
 * and the column's fade.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRow } from "@shared/work/messages";
import { MessagesDataProvider, type ThreadDraft } from "./data";
import { CHATS, COPY_DRAFT, fixtureData, HELD_DRAFT, JOB, type FixtureOptions } from "./fixtures";
import { cutToFit } from "./model";
import { MessagesScreen } from "./MessagesView";
import { patchPage, peekReturn, resetPages, typedFromDraft } from "./page";
import { StartThreadProvider } from "./threads";

vi.mock("work-kit/mail/lib/bytes", () => ({ loadBytes: async () => new Blob(["x"], { type: "image/png" }) }));
vi.mock("../shell/open", () => ({ openConnections: () => {} }));
vi.mock("../../components/ui/toaster", async (original) => ({ ...(await original<object>()), loadToast: async () => Object.assign(() => {}, { error: () => {} }) }));

const clipboard = vi.hoisted(() => ({ hold: null as null | (() => void) }));
beforeAll(() => {
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => (clipboard.hold ? new Promise<void>((go) => (clipboard.hold = go)) : Promise.resolve()) },
    configurable: true,
  });
  URL.createObjectURL = () => "blob:picture";
  URL.revokeObjectURL = () => {};
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  resetPages();
  clipboard.hold = null;
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
const failedLine = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-draft-failed]");
const flush = () => act(async () => {});
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const enter = () => fireEvent.keyDown(field(), { key: "Enter" });
const inComposer = (name: string) => within(composer()).queryByRole("button", { name });
const conversations = () => screen.getByRole("listbox", { name: "Conversations" });
const SECOND: ThreadDraft = { id: "held_2", held: true, text: "Also: the trailer cut is in the shared folder.", threadId: "t_trailer", thread: "Trailer cut" };

describe("a held reply that may have gone", () => {
  it("reads May have gone. with the Outbox's words, never Not sent., when its press failed with an unknown outcome", async () => {
    mount({ pressFails: "LifeOS did not answer in time", pressUnknown: true, lingers: true, drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    enter();
    await flush();
    const line = failedLine()!;
    expect(line.dataset.draftFailed).toBe("unknown");
    expect(line.textContent).toContain("May have gone.");
    expect(line.textContent).toContain("Check whether it went first");
    expect(line.textContent).not.toContain("Not sent.");
    expect(within(line).getByRole("button", { name: "Open in Outbox" })).toBeTruthy();
  });

  it("reads the same for an item the Outbox already lists as unknown", () => {
    mount({ drafts: { c_dana: [{ ...HELD_DRAFT, failed: "The link dropped", unknown: true }] } }, "c_dana");
    expect(failedLine()!.textContent).toContain("May have gone.");
    expect(failedLine()!.textContent).not.toContain("Not sent.");
  });
});

describe("the failed line", () => {
  it("names its thread in ink after the word, then the reason, and is a status", () => {
    mount({ drafts: { c_dana: [{ ...HELD_DRAFT, failed: "Slack said the thread is archived" }] } }, "c_dana");
    const line = failedLine()!;
    // The composer's own status region, always mounted, speaks it (round 6: a region that arrives filled is not spoken).
    expect(document.querySelector("[data-press-status]")!.getAttribute("role")).toBe("status");
    // Round 7 (Opus C2): it says why too, each part ending once.
    expect(document.querySelector("[data-press-status]")!.textContent).toBe(`Not sent. ${HELD_DRAFT.thread}. Slack said the thread is archived.`);
    const name = within(line).getByText(HELD_DRAFT.thread!);
    expect(name.className).toContain("text-foreground");
    expect(line.textContent!.indexOf("Not sent.")).toBeLessThan(line.textContent!.indexOf(HELD_DRAFT.thread!));
    expect(line.textContent!.indexOf(HELD_DRAFT.thread!)).toBeLessThan(line.textContent!.indexOf("Slack said the thread is archived"));
  });

  it("ends with the route's reason while the button is Copy", () => {
    mount({ drafts: { c_dana: [{ ...HELD_DRAFT, failed: "It couldn't be sent" }] }, routes: { c_dana: { can: false, why: "The Mac that sends iMessage is offline" } } }, "c_dana");
    expect(failedLine()!.textContent).toContain("The Mac that sends iMessage is offline");
    expect(inComposer("Copy")).toBeTruthy();
  });

  it("leaves the row without the amber mark of a draft waiting", () => {
    mount({ drafts: { c_dana: [{ ...HELD_DRAFT, failed: "It couldn't be sent" }] } });
    const row = within(conversations()).getAllByRole("option").find((o) => o.textContent!.includes("Dana Lee"))!;
    expect(row.getAttribute("aria-label")).not.toContain("a draft waits");
  });

  it("opens that very item in the Outbox", () => {
    const { data } = mount({ drafts: { c_dana: [{ ...HELD_DRAFT, failed: "It couldn't be sent", outboxKey: "box:host:held_1" }] } }, "c_dana");
    fireEvent.click(within(failedLine()!).getByRole("button", { name: "Open in Outbox" }));
    expect(data.log.outbox).toEqual(["box:host:held_1"]);
  });
});

describe("the field's origin, read against every draft", () => {
  it("empties the field of a held draft that failed elsewhere, while another draft waits, and his Send goes as his own", async () => {
    const { data } = mount({ drafts: { c_dana: [HELD_DRAFT, SECOND] } }, "c_dana");
    expect(typedFromDraft(WS, "c_dana")).toBe(HELD_DRAFT.id);
    act(() => data.failDraft(HELD_DRAFT.id, "Slack said the thread is archived"));
    await flush();
    expect(field().value).toBe("");
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
    // The other draft still waits behind Use draft; what he types is his own.
    expect(inComposer("Use draft")).toBeTruthy();
    type("Mine, by hand");
    enter();
    await flush();
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: "Mine, by hand" }]);
    expect(data.log.pressed).toEqual([]);
  });

  it("keeps an edit he was making as his own words when the item fails elsewhere", async () => {
    const { data } = mount({ drafts: { c_dana: [HELD_DRAFT, SECOND] } }, "c_dana");
    type(`${HELD_DRAFT.text} Edited.`);
    act(() => data.failDraft(HELD_DRAFT.id, "It couldn't be sent"));
    await flush();
    expect(field().value).toBe(`${HELD_DRAFT.text} Edited.`);
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
  });
});

describe("every async step judged by the field as pressed", () => {
  async function sendThenUseDraft(options: FixtureOptions) {
    const { data } = mount({ drafts: { c_dana: [HELD_DRAFT] }, ...options }, "c_dana");
    type("");
    type("My reply");
    enter();
    await flush();
    await act(async () => fireEvent.click(inComposer("Use draft")!));
    return data;
  }

  // Round 10: Undo's placement and Copy hold the conversation's gate, so the field is read only while they wait; what
  // these tests typed meanwhile can no longer be typed.
  it("Undo saves the draft's edit while the field is held read only, then places his recalled words", async () => {
    const data = await sendThenUseDraft({ slowSave: true });
    type(`${HELD_DRAFT.text} One.`);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await flush();
    expect(field().readOnly).toBe(true);
    type(`${HELD_DRAFT.text} One. Two.`);
    await act(async () => data.release());
    await flush();
    expect(data.log.saved.map((s) => s.text)).toEqual([`${HELD_DRAFT.text} One.`]);
    expect(field().value).toBe("My reply");
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
  });

  it("Copy holds the field read only while the clipboard is written, then its cleanup empties the field it found", async () => {
    const { data } = mount({ drafts: { c_playtest: [COPY_DRAFT] } }, "c_playtest");
    clipboard.hold = () => {};
    fireEvent.click(inComposer("Copy")!);
    expect(field().readOnly).toBe(true);
    type("A new reply of my own");
    await act(async () => clipboard.hold?.());
    await flush();
    expect(data.log.dropped).toEqual([COPY_DRAFT.id]);
    expect(field().value).toBe("");
  });
});

describe("keys handed to a named neighbour", () => {
  it("the last Unread row read away from under the keys hands them to Clear filter", async () => {
    const chats: ChatRow[] = CHATS.map((c) => ({ ...c, unread: c._id === "c_dana" }));
    mount({ chats });
    act(() => patchPage(WS, { filter: "unread" }));
    conversations().focus();
    fireEvent.keyDown(conversations(), { key: "ArrowDown" });
    await flush();
    expect(screen.getByText("Nothing unread")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear filter" }));
  });

  it("the open row leaving the wide Unread list makes the row now at its index the active one", async () => {
    const unread = new Set(["c_builds", "c_dana", "c_trio"]);
    mount({ chats: CHATS.map((c) => ({ ...c, unread: unread.has(c._id) })) });
    act(() => patchPage(WS, { filter: "unread" }));
    fireEvent.click(within(conversations()).getAllByRole("option")[1]!);
    await flush();
    expect(conversations().getAttribute("aria-activedescendant")).toBe("chat-row-c_trio");
  });

  it("widening past 640px with Back focused hands the keys to the open row in the list", async () => {
    const { data, view } = mount({}, null, true);
    fireEvent.keyDown(conversations(), { key: "ArrowDown" });
    fireEvent.keyDown(conversations(), { key: "Enter" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to Messages" }));
    view.rerender(screenOf(data, false));
    await flush();
    expect(document.activeElement).toBe(conversations());
  });

  it("2 new hands the keys to the column as it goes", async () => {
    const { data } = mount({}, "c_dana");
    await flush();
    const scroller = document.querySelector<HTMLElement>("[data-column]")!;
    scroller.scrollTop = -600;
    fireEvent.scroll(scroller);
    act(() => data.deliver("c_dana", "Dana Lee", "One more thing"));
    await flush();
    const pill = screen.getByRole("button", { name: /1 new/ });
    pill.focus();
    fireEvent.click(pill);
    expect(document.activeElement).toBe(screen.getByRole("log", { name: "Messages" }));
  });
});

describe("the way back into a search", () => {
  it("is dropped by a change of the words, so typing after Back onto a failed search keeps the field's keys", () => {
    mount({ searchFails: ["broken words"] }, null, true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "controller" } });
    const results = screen.getByRole("listbox", { name: "Search results" });
    fireEvent.keyDown(results, { key: "ArrowDown" });
    fireEvent.keyDown(results, { key: "Enter" });
    act(() => patchPage(WS, { query: "broken words" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    expect(peekReturn(WS)).not.toBeUndefined();
    const box = screen.getByRole("searchbox");
    box.focus();
    fireEvent.change(box, { target: { value: "controller" } });
    expect(peekReturn(WS)).toBeUndefined();
    expect(document.activeElement).toBe(box);
  });

  it("gives a cut hit's lead about two thirds of the line, and never leads a match at the start with …", () => {
    const fits = (room: number) => (line: string) => line.length <= room;
    const text = "@Alex can you confirm the controller fix on the second pad before we tell QA?";
    // The line holds 30, too few for the words through the match (36): cut, the lead and the match take at most 26 (about
    // two thirds), so words follow the match.
    expect(cutToFit(text, "controller", fits(40), fits(26))).toBe(text);
    const cut = cutToFit(text, "controller", fits(30), fits(20));
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.indexOf("controller") + "controller".length).toBeLessThanOrEqual(20);
    expect(cut).toBe("…the controller fix on the second pad before we tell QA?");
    expect(cutToFit("controllerpadfirmwareupdate is the whole word", "controllerpadfirmwareupdate", fits(10), fits(6))).toBe("controllerpadfirmwareupdate is the whole word");
  });
});

describe("the column's top edge", () => {
  it("fades at the toolbar's seam with the app's edge mask", async () => {
    mount({}, "c_dana");
    await flush();
    expect(document.querySelector<HTMLElement>("[data-column]")!.className).toContain("[mask-image:linear-gradient(to_bottom,transparent,var(--foreground)_12px)]");
  });
});
