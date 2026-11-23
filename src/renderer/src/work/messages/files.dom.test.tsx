// @vitest-environment jsdom
/**
 * A message's pictures and files: a picture drawn in place from LifeOS's bytes as a blob (no web
 * address in the page), a file's chip that views or downloads it, a file that could not come saying
 * why with the way to it in its app, the folded names gone from the words, a message's listed files
 * asked for once, and a file opened in the kind `kindForFile` names as a chat's canvas source.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@shared/work/messages";
import { MessagesDataProvider } from "./data";
import { FILE_FAILED, fixtureData, JOB, MESSAGES, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { patchPage, resetPages } from "./page";

const bytes = vi.hoisted(() => ({ read: [] as string[] }));
vi.mock("work-kit/mail/lib/bytes", () => ({ loadBytes: async (url: string) => (bytes.read.push(url), new Blob(["x"], { type: "image/png" })) }));
vi.mock("../shell/open", () => ({ openConnections: () => {} }));
const native = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("../../lib/native", async (original) => ({ ...(await original<object>()), openUrl: async (url: string) => void native.opened.push(url) }));
const canvas = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("../canvas/store", async (original) => ({ ...(await original<object>()), openItem: async (...args: unknown[]) => void canvas.items.push(args) }));

beforeAll(() => {
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  URL.createObjectURL = () => "blob:picture";
});
afterEach(() => {
  cleanup();
  resetPages();
});

const WS = "ws";
function mount(options: FixtureOptions, chatId: string) {
  const data = fixtureData(options);
  patchPage(WS, { chatId });
  render(
    <MessagesDataProvider value={data}>
      <MessagesScreen workspaceId={WS} job={JOB} narrow={false} />
    </MessagesDataProvider>,
  );
  return data;
}
const block = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-block="${id}"]`)!;

describe("a message's files", () => {
  it("asks LifeOS for a message's listed files once, as it comes into view", () => {
    const data = mount({}, "c_lucas");
    expect(data.log.requested).toEqual(["c_lucas_m3"]);
    act(() => patchPage(WS, { chatId: "c_dana" }));
    act(() => patchPage(WS, { chatId: "c_lucas" }));
    expect(data.log.requested).toEqual(["c_lucas_m3"]);
  });

  it("draws a stored picture in place from a blob, in its own shape, and no web address is in the page", async () => {
    const stored: ChatMessage = { _id: "pic", who: { name: "Ana Ruiz", me: false }, text: "[file: map.png]", sentAt: Date.now(), files: [{ _id: "f1", name: "map.png", contentType: "image/png", width: 1600, height: 900, status: "stored", url: "https://lifeos.example.dev/api/storage/abc" }] };
    mount({ messages: { ...MESSAGES, c_art: [stored] } }, "c_art");
    await act(async () => {});
    const picture = within(block("pic")).getByRole("img", { name: "map.png" }) as HTMLImageElement;
    expect(picture.getAttribute("src")).toBe("blob:picture");
    expect(picture.getAttribute("width")).toBe("360");
    expect(picture.getAttribute("height")).toBe("203");
    expect(bytes.read).toEqual(["https://lifeos.example.dev/api/storage/abc"]);
    for (const el of document.querySelectorAll("[src]")) expect(el.getAttribute("src")).not.toMatch(/^https?:/);
    expect(block("pic").textContent).not.toContain("[file:");
  });

  it("holds a picture's shape with a skeleton while LifeOS fetches it", () => {
    mount({}, "c_art");
    const waiting = within(block("c_art_m3")).getByLabelText("Loading launcher-banner.png");
    // Its own shape at most 360 wide, the height from its proportions, never wider than the message.
    expect(waiting.closest("button")!.getAttribute("style")).toContain("width: 360px; aspect-ratio: 360 / 120");
    expect(waiting.closest("button")!.className).toContain("max-w-full");
  });

  it("names each file's verb on its chip and opens it through the seam, a file still on its way once its address comes", () => {
    const data = mount({}, "c_lucas");
    expect(within(block("c_lucas_m1")).getByRole("button", { name: "View runner-budget.xlsx" })).toBeTruthy();
    // The build is only listed: its chip is pending (a spinner, the name muted), and a press waits for the address.
    const zip = within(block("c_lucas_m3")).getByRole("button", { name: "Download starboard-0.9.5-linux.zip, on its way" });
    expect(zip.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(zip);
    fireEvent.click(within(block("c_lucas_m1")).getByRole("button", { name: "View patch-notes-0.9.5.pdf" }));
    expect(data.log.opened).toEqual([{ chatId: "c_lucas", messageId: "c_lucas_m1", file: "f_notes", verb: "view" }]);
    act(() => data.storeFile("c_lucas", "c_lucas_m3", "f_zip", "https://lifeos.example.dev/api/storage/zip"));
    expect(data.log.opened).toEqual([
      { chatId: "c_lucas", messageId: "c_lucas_m1", file: "f_notes", verb: "view" },
      { chatId: "c_lucas", messageId: "c_lucas_m3", file: "f_zip", verb: "save" },
    ]);
    expect(within(block("c_lucas_m3")).getByRole("button", { name: "Download starboard-0.9.5-linux.zip" }).hasAttribute("aria-busy")).toBe(false);
    expect(block("c_lucas_m1").textContent).not.toContain("[file:");
  });

  it("says why a file could not come, with Open in its app", () => {
    mount({ messages: { ...MESSAGES, c_lucas: FILE_FAILED } }, "c_lucas");
    const line = block("c_lucas_m3").querySelector<HTMLElement>("[data-file-failed]")!;
    expect(line.textContent).toContain("Slack didn't let LifeOS read this file");
    fireEvent.click(within(line).getByRole("button", { name: "Open in Slack" }));
    expect(native.opened).toEqual(["https://starboard.slack.com/archives/c_lucas"]);
  });
});

describe("a chat's file in the canvas", () => {
  it("opens in the kind kindForFile names, as a chat's source in the view's own pane", async () => {
    const { liveData } = await import("./live");
    const data = liveData({ environmentId: "box", sector: "cosmic", client: null, state: "connected" }, "cosmic", "box", "ws");
    const message = MESSAGES.c_lucas!.find((m) => m._id === "c_lucas_m1")!;
    data.openFile("c_lucas", message, message.files[0]!);
    expect(canvas.items).toEqual([
      [
        "box",
        "msgpane_ws",
        {
          kind: "sheet",
          source: { at: "mail", from: "chat", threadId: "c_lucas", messageId: "c_lucas_m1", partId: "f_budget", name: "runner-budget.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 48_200 },
          title: "runner-budget.xlsx",
        },
      ],
    ]);
    expect(data.fileVerb(message.files[0]!)).toBe("view");
    expect(data.fileVerb({ _id: "z", name: "a.zip", contentType: "application/zip", status: "stored" })).toBe("save");
  });
});
