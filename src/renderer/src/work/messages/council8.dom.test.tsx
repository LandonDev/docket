// @vitest-environment jsdom
/**
 * What the council's eighth round asked of the Messages view, one behaviour a test, over the
 * fixtures' seam: every failed
 * file offers Try again, which asks anew; Retry's keys at 640px and into empty results; and the
 * file watched by its id while its message is outside a pinned page.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesDataProvider } from "./data";
import { FILE_FAILED, fixtureData, JOB, MESSAGES, type FixtureOptions } from "./fixtures";
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
const flush = () => act(async () => {});
const block = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-block="${id}"]`);

describe("a failed file", () => {
  it("offers Try again, which asks anew: on its way, then stored", async () => {
    const { data } = mount({ messages: { ...MESSAGES, c_lucas: FILE_FAILED } }, "c_lucas");
    await flush();
    const line = block("c_lucas_m3")!.querySelector<HTMLElement>("[data-file-failed]")!;
    expect(within(line).getByRole("button", { name: "Open in Slack" })).toBeTruthy();
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Try again" })));
    await flush();
    expect(data.log.requested).toContain("c_lucas_m3");
    expect(block("c_lucas_m3")!.querySelector("[data-file-failed]")).toBeNull();
    expect(within(block("c_lucas_m3")!).getByRole("button", { name: /starboard-0\.9\.5-linux\.zip, on its way/ })).toBeTruthy();
    act(() => data.storeFile("c_lucas", "c_lucas_m3", "f_zip", "https://lifeos.example.dev/api/storage/zip"));
    await flush();
    expect(within(block("c_lucas_m3")!).getByRole("button", { name: "Download starboard-0.9.5-linux.zip" })).toBeTruthy();
  });

  it("that fails again says the new reason", async () => {
    const { data } = mount({ messages: { ...MESSAGES, c_lucas: FILE_FAILED } }, "c_lucas");
    await flush();
    await act(async () => fireEvent.click(within(block("c_lucas_m3")!.querySelector<HTMLElement>("[data-file-failed]")!).getByRole("button", { name: "Try again" })));
    await flush();
    act(() => data.failFile("c_lucas", "c_lucas_m3", "f_zip", "Slack's file service did not answer"));
    await flush();
    const line = block("c_lucas_m3")!.querySelector<HTMLElement>("[data-file-failed]")!;
    expect(line.textContent).toContain("Slack's file service did not answer");
    expect(within(line).getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("Retry's keys", () => {
  it("at 640px go to the column that lands, not to Back", async () => {
    mount({ fail: { messages: 1 } }, null, true);
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Conversations" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Conversations" }), { key: "Enter" });
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await flush();
    expect(document.activeElement).toBe(screen.getByRole("log", { name: "Messages" }));
  });

  it("go to the composer when the conversation lands empty", async () => {
    mount({ fail: { messages: 1 }, messages: { ...MESSAGES, c_dana: [] } }, "c_dana");
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await flush();
    expect(screen.getByText("No messages yet")).toBeTruthy();
    expect(document.activeElement).toBe(field());
  });

  it("go to the search field when the list lands empty with no action", async () => {
    mount({ fail: { chats: 1 }, empty: true });
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await flush();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });
});

describe("a file watched by its id", () => {
  it("is read by the id asked for while its message is outside the pinned page, and opens once stored", async () => {
    const { data } = mount({ pageFixed: true }, "c_lucas");
    await flush();
    fireEvent.click(within(block("c_lucas_m3")!).getByRole("button", { name: /starboard-0\.9\.5-linux\.zip, on its way/ }));
    for (let i = 0; i < 60; i++) act(() => data.deliver("c_lucas", "Lucas Grey", `Build note ${i}.`));
    await flush();
    expect(data.log.fileReads).toContain("f_zip");
    expect(data.log.opened).toEqual([]);
    act(() => data.storeFile("c_lucas", "c_lucas_m3", "f_zip", "https://lifeos.example.dev/api/storage/zip"));
    await flush();
    expect(data.log.opened).toEqual([{ chatId: "c_lucas", messageId: "c_lucas_m3", file: "f_zip", verb: "save" }]);
    act(() => data.deliver("c_lucas", "Lucas Grey", "One more."));
    await flush();
    expect(data.log.opened).toHaveLength(1);
  });
});
