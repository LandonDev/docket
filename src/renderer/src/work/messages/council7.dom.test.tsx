// @vitest-environment jsdom
/**
 * What the council's seventh round asked of the Messages view, one behaviour a test, over the
 * fixtures' seam: an edit the Outbox refused to save is kept with its draft and Use draft brings it
 * back; a draft he pushed aside never refills on a remount; a file asked for opens though its
 * message left the loaded page; the field's focus ring at the composer's edge; Retry keeps the
 * keys in the list and the conversation; the draft line's reason wraps; and the failed line has no
 * tip repeating it, speaks why, and never doubles a stop.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesDataProvider } from "./data";
import { fixtureData, HELD_DRAFT, JOB, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { patchPage, resetPages } from "./page";
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
const inComposer = (name: string) => within(composer()).queryByRole("button", { name });
const block = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-block="${id}"]`);

describe("an edit the Outbox refused to save", () => {
  it("never refills a draft he pushed aside when the composer mounts again", () => {
    const { data, view } = mount({ drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    expect(field().value).toBe(HELD_DRAFT.text);
    type("");
    view.unmount();
    render(screenOf(data));
    expect(field().value).toBe("");
    expect(inComposer("Use draft")).toBeTruthy();
  });
});

describe("a file asked for whose message left the loaded page", () => {
  it("opens once stored, watched by its id", async () => {
    const { data } = mount({}, "c_lucas");
    await flush();
    fireEvent.click(within(block("c_lucas_m3")!).getByRole("button", { name: /starboard-0\.9\.5-linux\.zip, on its way/ }));
    // Sixty messages arrive: the page holds the newest fifty, so the file's message is no longer in it.
    for (let i = 0; i < 60; i++) act(() => data.deliver("c_lucas", "Lucas Grey", `Build note ${i}.`));
    await flush();
    expect(block("c_lucas_m3")).toBeNull();
    act(() => data.storeFile("c_lucas", "c_lucas_m3", "f_zip", "https://lifeos.example.dev/api/storage/zip"));
    await flush();
    expect(data.log.opened).toEqual([{ chatId: "c_lucas", messageId: "c_lucas_m3", file: "f_zip", verb: "save" }]);
    act(() => data.deliver("c_lucas", "Lucas Grey", "One more."));
    await flush();
    expect(data.log.opened).toHaveLength(1);
  });
});

describe("the composer's focus", () => {
  it("draws the field focus standard at its outer edge, for focus in the field alone", () => {
    mount({}, "c_dana");
    const box = document.querySelector<HTMLElement>("[data-composer-box]")!;
    expect(box.className).toContain("focus-field");
    expect(box.className).toContain("[&:focus-within:not(:has(textarea:focus))]:border-border");
    expect(box.className).not.toContain("has-focus:border-input");
    expect(box.contains(field())).toBe(true);
  });
});

describe("Retry keeps the keys", () => {
  it("in the list: the rows that land take them", async () => {
    mount({ fail: { chats: 1 } });
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await flush();
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Conversations" }));
  });

  it("in the list: a second failure's Retry takes them", async () => {
    mount({ fail: { chats: 2 } });
    screen.getByRole("button", { name: "Retry" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
  });

  it("in the conversation: the column that lands takes them", async () => {
    mount({ fail: { messages: 1 } }, "c_dana");
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await flush();
    expect(document.activeElement).toBe(screen.getByRole("log", { name: "Messages" }));
  });
});

describe("the draft line", () => {
  it("wraps its route reason whole and lets the title take the ellipsis", () => {
    mount({ drafts: { c_dana: [HELD_DRAFT] }, routes: { c_dana: { can: false, why: "The Mac that sends iMessage is offline" } } }, "c_dana");
    const line = document.querySelector<HTMLElement>("[data-draft-line]")!;
    expect(line.className).toContain("flex-wrap");
    expect(line.className).toContain("gap-x-2.5");
    expect(within(line).getByText("The Mac that sends iMessage is offline").className).not.toContain("truncate");
    expect(within(line).getByText(HELD_DRAFT.thread!).className).toContain("truncate");
  });
});

describe("the failed line", () => {
  it("has no tip repeating it on Open in Outbox, and its status says why, each sentence ending once", async () => {
    mount({ drafts: { c_dana: [{ ...HELD_DRAFT, thread: undefined, failed: "It couldn't be sent." }] } }, "c_dana");
    const button = within(document.querySelector<HTMLElement>("[data-draft-failed]")!).getByRole("button", { name: "Open in Outbox" });
    fireEvent.pointerEnter(button);
    fireEvent.focus(button);
    await flush();
    expect(screen.queryByRole("tooltip")).toBeNull();
    const status = document.querySelector("[data-press-status]")!.textContent!;
    expect(status).toBe("Not sent. It couldn't be sent.");
    expect(status).not.toContain("..");
  });

  it("speaks the outbox's words when it may have gone", () => {
    mount({ drafts: { c_dana: [{ ...HELD_DRAFT, failed: "The link dropped", unknown: true }] } }, "c_dana");
    expect(document.querySelector("[data-press-status]")!.textContent).toBe(`May have gone. ${HELD_DRAFT.thread}. Check whether it went first.`);
  });
});
