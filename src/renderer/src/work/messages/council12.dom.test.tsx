// @vitest-environment jsdom
/**
 * The council's twelfth round (COUNCIL-everything r2): words kept aside never take a draft's place, and a draft's
 * words never become his own before the host says how it ended. Two lost Sends keep both; a lost Send whose reply shows
 * above lets go; Use words waits for a field of his own; Undo while a draft sends keeps its words aside; a draft that
 * leaves the capped list stays the draft's until the host, asked by its id, says it ended.
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
const EDIT = `${HELD_DRAFT.text} Also the banner.`;

describe("words kept aside", () => {
  it("keeps both of two lost Sends, a line apart, for Use words", async () => {
    mount({ sendLost: true });
    await flush();
    type("On it.");
    enter();
    await flush();
    type("Back in 5.");
    enter();
    await flush();
    act(() => inComposer("Use words")!.click());
    expect(field().value).toBe("On it.\nBack in 5.");
  });

  it("let go once his reply with those words shows above: LifeOS took it", async () => {
    const data = mount({ sendUnknown: true });
    await flush();
    type("On it.");
    enter();
    await flush();
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: "On it." }]);
    expect(asideLine()).toBeNull();
    expect(field().value).toBe("");
  });

  it("never join a held draft's words in the field: Use words is off and Return presses the draft", async () => {
    const data = mount({ sendLost: true, drafts: { c_dana: [HELD_DRAFT] } });
    await flush();
    type("");
    type("Mine.");
    enter();
    await flush();
    act(() => inComposer("Use draft")!.click());
    expect(field().value).toBe(HELD_DRAFT.text);
    expect(inComposer("Use words")!.disabled).toBe(true);
    enter();
    await flush();
    expect(data.log.pressed).toEqual([{ id: HELD_DRAFT.id, text: HELD_DRAFT.text }]);
    expect(data.log.sent).toEqual([]);
    // The field is empty again: his words may come back now.
    expect(inComposer("Use words")!.disabled).toBe(false);
  });

  it("hold Undo's words while the field's draft is sending elsewhere, and give them back once it ended", async () => {
    const data = mount({ drafts: { c_dana: [HELD_DRAFT] } });
    await flush();
    type("");
    type("My reply");
    enter();
    await flush();
    act(() => inComposer("Use draft")!.click());
    type(EDIT);
    act(() => data.sendingElsewhere(HELD_DRAFT.id));
    await flush();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await flush();
    expect(field().value).toBe(EDIT);
    expect(field().readOnly).toBe(true);
    expect(asideLine()?.textContent).toContain("Taken back while a draft was sending");
    expect(inComposer("Use words")!.disabled).toBe(true);
    act(() => data.dropElsewhere(HELD_DRAFT.id));
    await flush();
    // Ended elsewhere: his edit is his own (the ruling), and the recalled words may join it, in front.
    act(() => inComposer("Use words")!.click());
    expect(field().value).toBe(`My reply\n${EDIT}`);
  });
});

describe("a draft that leaves the capped list while still held", () => {
  it("stays the draft's, read only, until the host says it ended; then his edit is his own", async () => {
    const data = mount({ drafts: { c_dana: [HELD_DRAFT] } });
    await flush();
    type(EDIT);
    act(() => data.hideDraft(HELD_DRAFT.id));
    await flush();
    expect(field().value).toBe(EDIT);
    expect(field().readOnly).toBe(true);
    expect(composer().textContent).toContain("Waiting in the Outbox");
    enter();
    await flush();
    expect(data.log.sent).toEqual([]);
    expect(data.log.pressed).toEqual([]);
    act(() => data.endHidden(HELD_DRAFT.id));
    await flush();
    expect(field().readOnly).toBe(false);
    enter();
    await flush();
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: EDIT }]);
  });
});
