// @vitest-environment jsdom
/**
 * The council's thirteenth round (COUNCIL-everything r3): a kept part goes only on evidence of that very press, never by
 * words alone (an older "On it." above, or one reply for two presses of the same words), and an Undo whose answer is
 * lost keeps the words it showed.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesDataProvider } from "./data";
import { fixtureData, JOB, MESSAGES, NOW, type FixtureOptions } from "./fixtures";
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
function mount(options: FixtureOptions = {}, chatId = "c_dana") {
  const data = fixtureData(options);
  patchPage(WS, { chatId });
  render(
    <MessagesDataProvider value={data}>
      <StartThreadProvider value={() => {}}>
        <MessagesScreen workspaceId={WS} job={JOB} narrow={false} />
      </StartThreadProvider>
    </MessagesDataProvider>,
  );
  return data;
}
const field = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
const composer = (): HTMLElement => document.querySelector<HTMLElement>("[data-composer]")!;
const flush = () => act(async () => {});
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const enter = () => fireEvent.keyDown(field(), { key: "Enter" });
const inComposer = (name: string) => within(composer()).queryByRole("button", { name }) as HTMLButtonElement | null;
const asideLine = () => composer().querySelector<HTMLElement>("[data-aside], [data-send-unknown]");


/** Dana's conversation with "On it." of his already above, sent 30 seconds before the view's now. */
const EARLIER: FixtureOptions["messages"] = {
  ...MESSAGES,
  c_dana: [{ _id: "c_dana_mine", who: { name: "Landon", me: true }, text: "On it.", sentAt: NOW - 30_000, files: [] }, ...MESSAGES.c_dana!],
};

describe("a kept part goes only on evidence of its own press", () => {
  it("stays when an older message of his with the same words is already above", async () => {
    mount({ sendLost: true, messages: EARLIER });
    await flush();
    type("On it.");
    enter();
    await flush();
    expect(asideLine()?.textContent).toContain("May have gone.");
    act(() => inComposer("Use words")!.click());
    expect(field().value).toBe("On it.");
  });

  it("lets one reply prove one of two presses of the same words, not both", async () => {
    const data = mount({ sendOutcomes: ["lost", "queued"], messages: EARLIER });
    await flush();
    type("On it.");
    enter();
    await flush();
    type("On it.");
    enter();
    await flush();
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: "On it." }]);
    act(() => inComposer("Use words")!.click());
    expect(field().value).toBe("On it.");
  });
});

describe("an Undo whose answer is lost", () => {
  it("keeps the words it showed, aside behind May have gone, though LifeOS took the reply back", async () => {
    const data = mount({ undoLost: true });
    await flush();
    type("My reply");
    enter();
    await flush();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await flush();
    expect(data.log.undone).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(field().value).toBe("");
    expect(asideLine()?.textContent).toContain("May have gone.");
    act(() => inComposer("Use words")!.click());
    expect(field().value).toBe("My reply");
  });
});
