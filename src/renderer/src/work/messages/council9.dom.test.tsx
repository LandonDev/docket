// @vitest-environment jsdom
/**
 * The council's ninth round: one rule in place of the recovery machinery. A held draft's words
 * stay in the field until the host has taken them: read only while its press goes; emptied when
 * it is taken or its item fails; left exactly as they were when it is refused, so a second Send
 * presses again; his own words if the item goes elsewhere. Then Undo during a pending press, two
 * held drafts, Try again's keys and refusal, and a Retry that finds the conversation gone.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesDataProvider, type ThreadDraft } from "./data";
import { FILE_FAILED, fixtureData, HELD_DRAFT, JOB, MESSAGES, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { patchPage, resetPages, typedFromDraft } from "./page";
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
const alertText = () => within(composer()).queryByRole("alert")?.textContent ?? null;
const block = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-block="${id}"]`);
const EDIT = `${HELD_DRAFT.text} Also the banner, in both sizes.`;
const TOO_LONG = "This reply is longer than LifeOS can send";
const SECOND: ThreadDraft = { id: "held_2", held: true, text: "Also: the trailer cut is in the shared folder.", threadId: "t_trailer", thread: "Trailer cut" };

describe("a held draft's press holds the field", () => {
  it("keeps its words on screen, read only, Send busy and Discard off, its line naming the thread, until the host answers", async () => {
    const { data } = mount({ slowDraft: true, drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    enter();
    expect(field().value).toBe(HELD_DRAFT.text);
    expect(field().readOnly).toBe(true);
    expect(field().getAttribute("aria-busy")).toBe("true");
    expect((inComposer("Send") as HTMLButtonElement).disabled).toBe(true);
    expect((inComposer("Discard") as HTMLButtonElement).disabled).toBe(true);
    expect(composer().textContent).toContain(`Drafted in${HELD_DRAFT.thread}`);
    // Typing and Return do nothing while it goes.
    type("Something else");
    expect(field().value).toBe(HELD_DRAFT.text);
    enter();
    await act(async () => data.release());
    await flush();
    expect(data.log.pressed).toEqual([{ id: HELD_DRAFT.id, text: HELD_DRAFT.text }]);
  });

  it("empties once the host has taken it", async () => {
    const { data } = mount({ drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    enter();
    await flush();
    expect(data.log.pressed).toHaveLength(1);
    expect(field().value).toBe("");
    expect(composer().textContent).not.toContain("Drafted in");
  });

  it("empties when the item failed, its words saved to it, and shows the failed line", async () => {
    mount({ pressFails: "Slack said the thread is archived", drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    type(EDIT);
    enter();
    await flush();
    expect(field().value).toBe("");
    expect(document.querySelector("[data-draft-failed]")!.textContent).toContain("Not sent.");
  });
});

describe("a refused held press", () => {
  it("leaves the edit in the field under the draft's line, and a second Send presses again with it", async () => {
    const { data } = mount({ refuseDraft: TOO_LONG, refuseDraftTimes: 1, drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    type(EDIT);
    enter();
    await flush();
    expect(field().value).toBe(EDIT);
    expect(typedFromDraft(WS, "c_dana")).toBe(HELD_DRAFT.id);
    expect(alertText()).toBe(TOO_LONG);
    expect(composer().textContent).toContain(`Drafted in${HELD_DRAFT.thread}`);
    expect(data.log.pressed).toEqual([]);
    enter();
    await flush();
    expect(data.log.pressed).toEqual([{ id: HELD_DRAFT.id, text: EDIT }]);
    expect(data.log.sent).toEqual([]);
    expect(field().value).toBe("");
  });

  it("leaves the words his own when the item goes elsewhere afterwards, and Send goes as his own reply", async () => {
    const { data } = mount({ refuseDraft: TOO_LONG, drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    type(EDIT);
    enter();
    await flush();
    act(() => data.dropElsewhere(HELD_DRAFT.id));
    await flush();
    expect(field().value).toBe(EDIT);
    expect(composer().textContent).not.toContain("Drafted in");
    enter();
    await flush();
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: EDIT }]);
    expect(data.log.pressed).toEqual([]);
  });

  it("is found as it was after leaving the conversation, a remount and the 640px crossing", async () => {
    const { data, view } = mount({ refuseDraft: TOO_LONG, drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    type(EDIT);
    enter();
    await flush();
    act(() => patchPage(WS, { chatId: "c_builds" }));
    act(() => patchPage(WS, { chatId: "c_dana" }));
    view.unmount();
    const again = render(screenOf(data));
    again.rerender(screenOf(data, true));
    again.rerender(screenOf(data, false));
    await flush();
    expect(field().value).toBe(EDIT);
    expect(typedFromDraft(WS, "c_dana")).toBe(HELD_DRAFT.id);
    expect(composer().textContent).toContain(`Drafted in${HELD_DRAFT.thread}`);
  });

  it("with two held drafts touches only the one pressed", async () => {
    const { data } = mount({ refuseDraft: TOO_LONG, refuseDraftTimes: 1, drafts: { c_dana: [HELD_DRAFT, SECOND] } }, "c_dana");
    type(EDIT);
    enter();
    await flush();
    expect(field().value).toBe(EDIT);
    expect(data.log.saved).toEqual([]);
    expect(data.log.dropped).toEqual([]);
    enter();
    await flush();
    expect(data.log.pressed).toEqual([{ id: HELD_DRAFT.id, text: EDIT }]);
    // The second waits behind Use draft, its words never put in the field by the first's press.
    expect(field().value).toBe("");
    expect(composer().textContent).toContain(`Drafted in${SECOND.thread}`);
    expect(inComposer("Use draft")).toBeTruthy();
  });
});

describe("refusals", () => {
  it("of Discard leave the field, its origin and the draft as they were, and show the reason", async () => {
    const { data } = mount({ discardRefused: "The Outbox did not answer", drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    type(EDIT);
    await act(async () => fireEvent.click(inComposer("Discard")!));
    await flush();
    expect(field().value).toBe(EDIT);
    expect(typedFromDraft(WS, "c_dana")).toBe(HELD_DRAFT.id);
    expect(alertText()).toBe("The Outbox did not answer");
    expect(composer().textContent).toContain(`Drafted in${HELD_DRAFT.thread}`);
    expect(data.log.dropped).toEqual([]);
  });

  it("of his own Send, after a held refusal, show their own reason", async () => {
    mount({ refuseDraft: TOO_LONG, refuseSend: "LifeOS can't reply to a conversation you left", drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    enter();
    await flush();
    expect(alertText()).toBe(TOO_LONG);
    type("");
    type("Mine");
    enter();
    await flush();
    expect(alertText()).toBe("LifeOS can't reply to a conversation you left");
    expect(field().value).toBe("Mine");
  });
});

describe("Undo while a held draft's press is on its way", () => {
  async function pressWithReplyToUndo(options: FixtureOptions) {
    const { data } = mount({ slowDraft: true, drafts: { c_dana: [HELD_DRAFT] }, ...options }, "c_dana");
    type("");
    type("My reply");
    enter();
    await flush();
    await act(async () => fireEvent.click(inComposer("Use draft")!));
    return data;
  }

  it("recalls at once and places the words after the press is taken: the field holds only his recalled words", async () => {
    const data = await pressWithReplyToUndo({});
    enter();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await flush();
    expect(data.log.undone).toHaveLength(1);
    expect(field().value).toBe(HELD_DRAFT.text);
    await act(async () => data.release());
    await flush();
    expect(field().value).toBe("My reply");
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
    expect(data.log.pressed).toHaveLength(1);
  });

  it("after a refused press saves the draft's edit to the item, then places his words", async () => {
    const data = await pressWithReplyToUndo({ refuseDraft: TOO_LONG });
    type(EDIT);
    enter();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await act(async () => data.release());
    await flush();
    expect(data.log.saved).toEqual([{ id: HELD_DRAFT.id, text: EDIT }]);
    expect(field().value).toBe("My reply");
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
    expect(data.log.pressed).toEqual([]);
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: "My reply" }]);
  });

  it("when that save is refused too keeps the edit behind his words, nothing lost, nothing sent", async () => {
    const data = await pressWithReplyToUndo({ refuseDraft: TOO_LONG, saveRefused: "The Outbox did not answer" });
    type(EDIT);
    enter();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await act(async () => data.release());
    await flush();
    expect(field().value).toBe(`My reply\n${EDIT}`);
    // Round 10: the save's refusal shows in the composer's alert, the recalled row having left.
    expect(alertText()).toBe("The Outbox did not answer");
    expect(data.log.pressed).toEqual([]);
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: "My reply" }]);
  });
});

describe("Try again on a failed file", () => {
  it("by keyboard keeps the keys: the chip that takes the line's place gets them", async () => {
    mount({ messages: { ...MESSAGES, c_lucas: FILE_FAILED } }, "c_lucas");
    await flush();
    const again = within(block("c_lucas_m3")!.querySelector<HTMLElement>("[data-file-failed]")!).getByRole("button", { name: "Try again" });
    again.focus();
    await act(async () => fireEvent.click(again));
    await flush();
    expect(document.activeElement).toBe(within(block("c_lucas_m3")!).getByRole("button", { name: /starboard-0\.9\.5-linux\.zip, on its way/ }));
  });

  it("refused by LifeOS says that refusal on the same line, its Try again keeping the keys", async () => {
    mount({ requestFails: 1, messages: { ...MESSAGES, c_lucas: FILE_FAILED } }, "c_lucas");
    await flush();
    const again = within(block("c_lucas_m3")!.querySelector<HTMLElement>("[data-file-failed]")!).getByRole("button", { name: "Try again" });
    again.focus();
    await act(async () => fireEvent.click(again));
    await flush();
    const line = block("c_lucas_m3")!.querySelector<HTMLElement>("[data-file-failed]")!;
    expect(line.textContent).toContain("LifeOS did not answer");
    expect(line.textContent).not.toContain("Slack didn't let LifeOS read this file");
    expect(document.activeElement).toBe(within(line).getByRole("button", { name: "Try again" }));
  });
});

describe("a Retry that finds the conversation gone", () => {
  it("gives the keys to Back to Messages", async () => {
    mount({ fail: { chat: 1 } }, "c_nowhere");
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await flush();
    expect(screen.getByText("This conversation is no longer here")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to Messages" }));
  });
});
