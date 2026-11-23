// @vitest-environment jsdom
/**
 * The council's tenth round: two mechanisms. One gate a conversation for every composer action
 * that waits on the host (nothing starts while one runs; Undo's placement queues), with the held
 * press's line and button frozen to the press; and one keeper for the keys wherever a focused
 * control is swapped out (attachments across retries, the Outbox quote, the panes' Retry).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@shared/work/messages";
import { MessagesDataProvider, type ThreadDraft } from "./data";
import { discardRefusal } from "./drafts";
import { FILE_FAILED, fixtureData, HELD_DRAFT, JOB, MESSAGES, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { gateOf, patchPage, resetPages, typedFromDraft } from "./page";
import { StartThreadProvider } from "./threads";

const bytes = vi.hoisted(() => ({ read: 0 }));
vi.mock("work-kit/mail/lib/bytes", () => ({ loadBytes: async () => (bytes.read++, new Blob(["x"], { type: "image/png" })) }));
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
  URL.createObjectURL = () => `blob:picture-${bytes.read}`;
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
const SECOND: ThreadDraft = { id: "held_2", held: true, text: "Also: the trailer cut is in the shared folder.", threadId: "t_trailer", thread: "Trailer cut" };

/** His own reply sent (it offers Undo), then the held draft taken into the field. */
async function replyThenDraft(options: FixtureOptions) {
  const { data } = mount({ drafts: { c_dana: [HELD_DRAFT] }, ...options }, "c_dana");
  type("");
  type("My reply");
  enter();
  await flush();
  await act(async () => fireEvent.click(inComposer("Use draft")!));
  return data;
}

describe("the gate", () => {
  it("lets nothing start while Undo's save holds it: Send and Return do nothing, the field read only", async () => {
    const data = await replyThenDraft({ slowSave: true });
    type(EDIT);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await flush();
    expect(gateOf(WS, "c_dana")?.kind).toBe("undo");
    expect(field().readOnly).toBe(true);
    expect((inComposer("Send") as HTMLButtonElement).disabled).toBe(true);
    enter();
    await act(async () => data.release());
    await flush();
    expect(data.log.pressed).toEqual([]);
    expect(data.log.saved).toEqual([{ id: HELD_DRAFT.id, text: EDIT }]);
    expect(field().value).toBe("My reply");
    expect(gateOf(WS, "c_dana")).toBeUndefined();
  });

  it("queues Undo's placement behind a Discard: the recall goes at once, the words come once the Discard settles", async () => {
    const data = await replyThenDraft({ slowDrop: true });
    fireEvent.click(inComposer("Discard")!);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await flush();
    expect(data.log.undone).toHaveLength(1);
    expect(field().value).toBe(HELD_DRAFT.text);
    await act(async () => data.release());
    await flush();
    expect(data.log.dropped).toEqual([HELD_DRAFT.id]);
    expect(field().value).toBe("My reply");
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
  });

  it("freezes a held press's line and button to the press while the live list and the route change under it", async () => {
    const { data } = mount({ slowDraft: true, drafts: { c_dana: [HELD_DRAFT, SECOND] } }, "c_dana");
    enter();
    // The host lists the pressed item as sending (it leaves the waiting list) and the route goes away, before the answer.
    act(() => data.dropElsewhere(HELD_DRAFT.id));
    act(() => data.setRoute("c_dana", { can: false, why: "The Mac that sends iMessage is offline" }));
    await flush();
    expect(composer().textContent).toContain(`Drafted in${HELD_DRAFT.thread}`);
    expect(composer().textContent).not.toContain(SECOND.thread);
    expect((inComposer("Send") as HTMLButtonElement).disabled).toBe(true);
    expect(inComposer("Copy")).toBeNull();
    expect((inComposer("Discard") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => data.release());
    await flush();
    // Settled: the latest list and route apply.
    expect(field().value).toBe("");
    expect(composer().textContent).toContain(`Drafted in${SECOND.thread}`);
    expect(inComposer("Copy")).toBeTruthy();
  });

  it("puts a refused save of Undo's in the composer's alert, after the recalled row has left", async () => {
    const data = await replyThenDraft({ refuseDraft: "It changed since it was held; look again", saveRefused: "The Outbox did not answer" });
    type(EDIT);
    enter();
    await flush();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await flush();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(alertText()).toBe("The Outbox did not answer");
    expect(field().value).toBe(`My reply\n${EDIT}`);
    expect(data.log.pressed).toEqual([]);
  });
});

describe("Discard and the host's answer", () => {
  it("settles only a discarded item: one already sending keeps the field and says so", async () => {
    const { data } = mount({ discardAnswer: "sending", drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    type(EDIT);
    await act(async () => fireEvent.click(inComposer("Discard")!));
    await flush();
    expect(field().value).toBe(EDIT);
    expect(typedFromDraft(WS, "c_dana")).toBe(HELD_DRAFT.id);
    expect(alertText()).toBe("Already sending from the Outbox");
    expect(composer().textContent).toContain(`Drafted in${HELD_DRAFT.thread}`);
    expect(data.log.dropped).toEqual([]);
  });

  it("reads the answer in plain words", () => {
    expect(discardRefusal({ state: "discarded" })).toBeNull();
    expect(discardRefusal({ state: "sending" })).toBe("Already sending from the Outbox");
    expect(discardRefusal({ state: "sent" })).toBe("Already sent from the Outbox");
    expect(discardRefusal({ state: "stale", error: "It changed since it was held" })).toBe("It changed since it was held");
  });
});

describe("the keeper", () => {
  it("hands the keys from a picture's byte Try again to the picture that takes the line's place", async () => {
    const stored: ChatMessage = { _id: "pic", who: { name: "Ana Ruiz", me: false }, text: "", sentAt: Date.now(), files: [{ _id: "f1", name: "map.png", contentType: "image/png", width: 800, height: 600, status: "stored", url: "https://lifeos.example.dev/api/storage/map" }] };
    mount({ messages: { ...MESSAGES, c_art: [stored] } }, "c_art");
    await flush();
    fireEvent.error(within(block("pic")!).getByRole("img"));
    const again = within(block("pic")!).getByRole("button", { name: "Try again" });
    again.focus();
    await act(async () => fireEvent.click(again));
    await flush();
    expect(document.activeElement).toBe(within(block("pic")!).getByRole("button", { name: "View map.png" }));
  });

  it("carries the keys across a worker re-fetch that fails again: chip, then the line's Try again", async () => {
    const { data } = mount({ messages: { ...MESSAGES, c_lucas: FILE_FAILED } }, "c_lucas");
    await flush();
    const again = within(block("c_lucas_m3")!.querySelector<HTMLElement>("[data-file-failed]")!).getByRole("button", { name: "Try again" });
    again.focus();
    await act(async () => fireEvent.click(again));
    await flush();
    expect(document.activeElement).toBe(within(block("c_lucas_m3")!).getByRole("button", { name: /starboard-0\.9\.5-linux\.zip, on its way/ }));
    act(() => data.failFile("c_lucas", "c_lucas_m3", "f_zip", "Slack's file service did not answer"));
    await flush();
    expect(document.activeElement).toBe(within(block("c_lucas_m3")!.querySelector<HTMLElement>("[data-file-failed]")!).getByRole("button", { name: "Try again" }));
  });

  it("keeps them through a second Try again after a refused re-ask, to the chip", async () => {
    mount({ requestFails: 1, messages: { ...MESSAGES, c_lucas: FILE_FAILED } }, "c_lucas");
    await flush();
    const line = () => block("c_lucas_m3")!.querySelector<HTMLElement>("[data-file-failed]")!;
    within(line()).getByRole("button", { name: "Try again" }).focus();
    await act(async () => fireEvent.click(within(line()).getByRole("button", { name: "Try again" })));
    await flush();
    expect(line().textContent).toContain("LifeOS did not answer");
    expect(document.activeElement).toBe(within(line()).getByRole("button", { name: "Try again" }));
    await act(async () => fireEvent.click(within(line()).getByRole("button", { name: "Try again" })));
    await flush();
    expect(document.activeElement).toBe(within(block("c_lucas_m3")!).getByRole("button", { name: /starboard-0\.9\.5-linux\.zip, on its way/ }));
  });

  it("never takes the keys from elsewhere", async () => {
    const { data } = mount({ messages: { ...MESSAGES, c_lucas: FILE_FAILED } }, "c_lucas");
    await flush();
    field().focus();
    act(() => data.storeFile("c_lucas", "c_lucas_m3", "f_zip", "https://lifeos.example.dev/api/storage/zip"));
    await flush();
    expect(document.activeElement).toBe(field());
  });
});
