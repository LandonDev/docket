// @vitest-environment jsdom
/**
 * The council's eleventh round (COUNCIL-everything r1): nothing he did not mean goes twice or as his own. A draft sent or
 * discarded elsewhere takes its untouched words out of the field; one another window is sending stays the draft's, read
 * only, until it ends; Use draft and the failure cleanup wait for whatever holds the gate; his Send whose answer was lost
 * keeps its words aside behind "May have gone." until he puts them back.
 */
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesDataProvider } from "./data";
import { fixtureData, HELD_DRAFT, JOB, type FixtureOptions } from "./fixtures";
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

describe("a draft that leaves the Outbox elsewhere", () => {
  it("takes its untouched words out of the field, so Return sends nothing", async () => {
    const data = mount({ drafts: { c_dana: [HELD_DRAFT] } });
    await flush();
    expect(field().value).toBe(HELD_DRAFT.text);
    act(() => data.dropElsewhere(HELD_DRAFT.id));
    await flush();
    expect(field().value).toBe("");
    enter();
    await flush();
    expect(data.log.sent).toEqual([]);
  });

  it("takes them too when Use draft put them in an empty field", async () => {
    const data = mount({ drafts: { c_dana: [HELD_DRAFT] } });
    await flush();
    type("");
    act(() => inComposer("Use draft")!.click());
    expect(field().value).toBe(HELD_DRAFT.text);
    act(() => data.dropElsewhere(HELD_DRAFT.id));
    await flush();
    expect(field().value).toBe("");
  });
});

describe("a draft another window is sending", () => {
  it("stays the draft's, read only, Send off, until it ends; nothing goes from here", async () => {
    const data = mount({ drafts: { c_dana: [HELD_DRAFT] } });
    await flush();
    type(`${HELD_DRAFT.text} Edited.`);
    act(() => data.sendingElsewhere(HELD_DRAFT.id));
    await flush();
    expect(field().readOnly).toBe(true);
    expect(inComposer("Send")!.disabled).toBe(true);
    expect(inComposer("Discard")).toBeNull();
    expect(composer().textContent).toContain("Sending from the Outbox");
    enter();
    await flush();
    expect(data.log.sent).toEqual([]);
    expect(data.log.pressed).toEqual([]);
  });
});

describe("the gate holds the field", () => {
  it("offers no Use draft while his Send goes, and a refused Send puts back his own words alone", async () => {
    const data = mount({ slow: true, refuseSend: "No route", drafts: { c_dana: [HELD_DRAFT] } });
    await flush();
    type("");
    type("Mine.");
    enter();
    expect(inComposer("Use draft")).toBeNull();
    await act(async () => data.release());
    await flush();
    expect(field().value).toBe("Mine.");
    expect(typedFromDraft(WS, "c_dana")).toBeNull();
    expect(data.log.pressed).toEqual([]);
  });

  it("keeps a draft's words while a Discard holds the gate, though another window fails it meanwhile", async () => {
    const data = mount({ slowDrop: true, discardRefused: "Not now", drafts: { c_dana: [HELD_DRAFT] } });
    await flush();
    act(() => inComposer("Discard")!.click());
    act(() => data.failDraft(HELD_DRAFT.id, "Slack said no"));
    await flush();
    expect(field().value).toBe(HELD_DRAFT.text);
    await act(async () => data.release());
    await flush();
    // Settled, the cleanup runs: the failed item's words are the Outbox's.
    expect(field().value).toBe("");
  });
});

describe("his Send whose answer was lost", () => {
  it("keeps the words aside behind May have gone, never under a plain Send, until Use words", async () => {
    const data = mount({ sendUnknown: true });
    await flush();
    type("On it.");
    enter();
    await flush();
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: "On it." }]);
    expect(field().value).toBe("");
    expect(composer().querySelector("[data-send-unknown]")?.textContent).toContain("May have gone.");
    expect(inComposer("Send")!.disabled).toBe(true);
    act(() => inComposer("Use words")!.click());
    expect(field().value).toBe("On it.");
    expect(composer().querySelector("[data-send-unknown]")).toBeNull();
  });
});
