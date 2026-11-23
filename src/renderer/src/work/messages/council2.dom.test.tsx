// @vitest-environment jsdom
/**
 * What the council's second round asked of the Messages view, one behaviour a test, over the
 * fixtures' seam: a draft that stays a draft across a remount; a pending Send or Discard that
 * leaves his edits alone; the read mark only after the column has placed him; the newest row
 * counted after an Undo; a picture that will not draw; Back's return to a hit or the nearest row;
 * a search that keeps its hits while the next words are asked; and the smaller lines.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@shared/work/messages";
import { MessagesDataProvider } from "./data";
import { CHATS, COPY_DRAFT, fixtureData, HELD_DRAFT, JOB, MESSAGES, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { endVisit, keepVisitSince, patchPage, resetPages, visitSince } from "./page";
import { StartThreadProvider } from "./threads";

const bytes = vi.hoisted(() => ({ read: [] as string[] }));
vi.mock("work-kit/mail/lib/bytes", () => ({ loadBytes: async (url: string) => (bytes.read.push(url), new Blob(["x"], { type: "image/png" })) }));
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
  URL.createObjectURL = () => `blob:picture-${bytes.read.length}`;
  URL.revokeObjectURL = () => {};
});
beforeEach(() => {
  resetPages();
  bytes.read.length = 0;
});
afterEach(() => cleanup());

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
const flush = () => act(async () => {});
const press = async (name: string) => act(async () => fireEvent.click(within(composer()).getByRole("button", { name })));

describe("the composer across visits and while a press goes", () => {
  it("keeps a held draft a draft after the conversation is left and opened again, and Send presses it once", async () => {
    const { data, view } = mount({ drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    fireEvent.change(field(), { target: { value: "Thursday works, edited." } });
    act(() => patchPage(WS, { chatId: "c_builds" }));
    act(() => patchPage(WS, { chatId: "c_dana" }));
    view.unmount();
    render(screenOf(data));
    expect(field().value).toBe("Thursday works, edited.");
    expect(composer().textContent).not.toContain("Use draft");
    await press("Send");
    expect(data.log.pressed).toEqual([{ id: HELD_DRAFT.id, text: "Thursday works, edited." }]);
    expect(data.log.sent).toEqual([]);
  });

  it("leaves a reply he wrote over the words while Send went exactly as he left it", async () => {
    const { data } = mount({ slow: true }, "c_dana");
    fireEvent.change(field(), { target: { value: "Yes" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    fireEvent.change(field(), { target: { value: "Yesterday works." } });
    await act(async () => data.release());
    await flush();
    expect(field().value).toBe("Yesterday works.");
  });

  it("empties the field on Discard only while it still holds the draft's words", async () => {
    mount({ drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    await press("Discard");
    expect(field().value).toBe("");
    cleanup();
    resetPages();
    mount({ drafts: { c_playtest: [COPY_DRAFT] } }, "c_playtest");
    // Emptied, the field's next words are his own: Discard leaves them.
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.change(field(), { target: { value: "My own thanks" } });
    await press("Discard");
    expect(field().value).toBe("My own thanks");
  });

  it("puts a copy-only draft's reason before its controls, so the line ends with Open thread", () => {
    mount({ drafts: { c_playtest: [COPY_DRAFT] } }, "c_playtest");
    const line = composer().firstElementChild!.textContent!;
    expect(line.indexOf("LifeOS can't reply in Discord yet")).toBeLessThan(line.indexOf("Open thread"));
    expect(line.trim().endsWith("Open thread")).toBe(true);
  });
});

describe("the conversation's read mark and its newest row", () => {
  it("writes no read mark while the messages did not come, and keeps New across Retry", async () => {
    const { data } = mount({ fail: { messages: 1 } }, "c_dana");
    await flush();
    expect(data.log.read).toEqual([]);
    const since = visitSince(WS, "c_dana");
    expect(since).not.toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(data.log.read).toEqual(["c_dana"]);
    expect(visitSince(WS, "c_dana")).toBe(since);
    expect(within(block("c_dana_m8")).getByRole("separator").getAttribute("aria-label")).toContain("New");
  });

  it("ends a visit when he leaves the conversation", () => {
    keepVisitSince(WS, "c_x", 5);
    endVisit(WS, "c_x");
    expect(visitSince(WS, "c_x")).toBeUndefined();
    mount({}, "c_dana");
    expect(visitSince(WS, "c_dana")).not.toBeUndefined();
    act(() => patchPage(WS, { chatId: "c_builds" }));
    expect(visitSince(WS, "c_dana")).toBeUndefined();
  });

  it("keeps counting arrivals after he takes back the newest message", async () => {
    const { data } = mount({}, "c_dana");
    fireEvent.change(field(), { target: { value: "Wrong chat" } });
    await press("Send");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await flush();
    act(() => data.deliver("c_dana", "Dana Lee", "Did you see the banner?"));
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Dana Lee: Did you see the banner?");
    expect(block("c_dana_in1").className).toContain("tc-message-arrives");
  });

  it("names the list's row in a failed conversation's toolbar and draws no More there", () => {
    mount({ fail: { chat: 1 } }, "c_dana");
    const toolbar = screen.getByText("This conversation did not load").closest(".flex.h-full")!;
    expect(within(toolbar as HTMLElement).getByRole("heading", { name: "Dana Lee" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("keeps the bones on the column's measure", () => {
    mount({ messagesLoading: true }, "c_dana");
    expect(screen.getByLabelText("Loading messages").className).toContain("[scrollbar-gutter:stable]");
  });

  it("quotes 'Writer: words' whole, for the line to cut", () => {
    const long = "A very long first message that runs well past eighty characters so the line, not the code, decides where it stops";
    const lines: ChatMessage[] = [
      { _id: "q1", who: { name: "Mia Chen", me: false }, text: long, sentAt: Date.now() - 60_000, files: [] },
      { _id: "q2", who: { name: "Theo Park", me: false }, text: "Between", sentAt: Date.now() - 50_000, files: [] },
      { _id: "q3", who: { name: "Ana Ruiz", me: false }, text: "Agreed", sentAt: Date.now() - 40_000, files: [], replyTo: { who: "Mia Chen", text: long } },
    ].reverse();
    mount({ messages: { ...MESSAGES, c_design: lines } }, "c_design");
    expect(block("q3").textContent).toContain(`Mia Chen: ${long}`);
  });
});

describe("pictures that will not draw", () => {
  it("falls to the failure line with Try again and Open in Slack when the bytes do not decode, and draws again", async () => {
    const stored: ChatMessage = { _id: "pic", who: { name: "Ana Ruiz", me: false }, text: "", sentAt: Date.now(), files: [{ _id: "f1", name: "map.png", contentType: "image/png", width: 800, height: 600, status: "stored", url: "https://lifeos.example.dev/api/storage/map" }] };
    mount({ messages: { ...MESSAGES, c_art: [stored] } }, "c_art");
    await flush();
    fireEvent.error(within(block("pic")).getByRole("img"));
    const line = block("pic").querySelector<HTMLElement>("[data-file-failed]")!;
    expect(within(line).getByRole("button", { name: "Open in Slack" })).toBeTruthy();
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Try again" })));
    await flush();
    expect(bytes.read).toEqual(["https://lifeos.example.dev/api/storage/map", "https://lifeos.example.dev/api/storage/map"]);
    expect(within(block("pic")).getByRole("img")).toBeTruthy();
  });

  it("reads one address once, however many pictures draw it", async () => {
    const file = { _id: "f1", name: "same.png", contentType: "image/png", width: 400, height: 300, status: "stored" as const, url: "https://lifeos.example.dev/api/storage/same" };
    const two: ChatMessage[] = [
      { _id: "p2", who: { name: "Ana Ruiz", me: false }, text: "", sentAt: Date.now(), files: [{ ...file, _id: "f2" }] },
      { _id: "p1", who: { name: "Ana Ruiz", me: false }, text: "", sentAt: Date.now() - 1000, files: [file] },
    ];
    mount({ messages: { ...MESSAGES, c_art: two } }, "c_art");
    await flush();
    expect(bytes.read).toEqual(["https://lifeos.example.dev/api/storage/same"]);
  });
});

describe("the list", () => {
  it("keeps the last hits on screen while the next words are asked", () => {
    mount({ searchPending: "controllers" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "controller" } });
    const before = within(screen.getByRole("listbox", { name: "Search results" })).getAllByRole("option").length;
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "controllers" } });
    expect(document.querySelector("[data-row-bones]")).toBeNull();
    expect(within(screen.getByRole("listbox", { name: "Search results" })).getAllByRole("option")).toHaveLength(before);
  });

  it("leads a direct chat's hit with nothing but You", () => {
    mount();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "crash numbers" } });
    const hit = within(screen.getByRole("listbox", { name: "Search results" })).getAllByRole("option")[0]!;
    expect(hit.textContent).toContain("Can you send me the crash numbers");
    expect(hit.textContent).not.toContain("Dana: ");
  });

  it("under 640px gives the keys back to the hit he opened", () => {
    mount({}, null, true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "controller" } });
    const results = screen.getByRole("listbox", { name: "Search results" });
    fireEvent.keyDown(results, { key: "ArrowDown" });
    fireEvent.keyDown(results, { key: "ArrowDown" });
    const hit = results.getAttribute("aria-activedescendant");
    fireEvent.keyDown(results, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    const again = screen.getByRole("listbox", { name: "Search results" });
    expect(document.activeElement).toBe(again);
    expect(again.getAttribute("aria-activedescendant")).toBe(hit);
  });

  it("under 640px in Unread gives the keys to the row now in place, or to Clear filter when none is left", () => {
    const one = CHATS.map((c) => ({ ...c, unread: c._id === "c_dana" }));
    mount({ chats: one }, null, true);
    act(() => patchPage(WS, { filter: "unread" }));
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Conversations" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Conversations" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    expect(screen.getByText("Nothing unread")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear filter" }));
  });

  it("says its bones are loading conversations", () => {
    mount({ loading: true });
    const bones = screen.getByRole("status", { name: "Loading conversations" });
    expect(bones.getAttribute("aria-busy")).toBe("true");
  });
});
