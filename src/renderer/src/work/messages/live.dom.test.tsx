// @vitest-environment jsdom
/**
 * The live seam's answers that guard his words (docs/agents/work-messages.md "Replies"): his Send's failure read as
 * refused or as may-have-gone, a Discard of a draft the list no longer holds refused rather than taken, the copy-only
 * drafts asked for again when the host's link opens, and a file the host will not open beside the conversation said.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionLostError, registry, TimeoutError } from "../../lib/connection";
import type { ChatFile } from "@shared/work/messages";

const seen = vi.hoisted(() => ({ toasts: [] as string[], opens: 0 }));
vi.mock("../../components/ui/toaster", async (original) => ({
  ...(await original<object>()),
  loadToast: async () => Object.assign((words: string) => void seen.toasts.push(words), { error: (words: string) => void seen.toasts.push(`error: ${words}`) }),
}));
vi.mock("../canvas/store", async (original) => ({ ...(await original<object>()), openItem: async () => (seen.opens++, Promise.reject(new Error("refused: the host is away"))) }));

type Fake = { request: ReturnType<typeof vi.fn>; opens: (() => void)[] };
function fakeLink(request: (method: string) => Promise<unknown>): Fake {
  const fake: Fake = { request: vi.fn(request), opens: [] };
  vi.spyOn(registry, "linkOf").mockReturnValue({ request: fake.request, onPush: () => () => {}, onOpen: (fn: () => void) => (fake.opens.push(fn), () => {}) } as never);
  return fake;
}
const flush = () => act(async () => {});
const data = async (workspaceId = "ws") => (await import("./live")).liveData({ environmentId: "box", sector: "cosmic", client: null, state: "connected" } as never, "cosmic", "box", workspaceId);

afterEach(() => {
  vi.restoreAllMocks();
  seen.toasts.length = 0;
});

describe("his Send's failure", () => {
  const failure = async (err: unknown) => {
    fakeLink(() => Promise.reject(err));
    return (await data()).send("c1", "On it.").then(
      () => null,
      (e: Error & { unknown?: boolean }) => ({ words: e.message, unknown: e.unknown === true }),
    );
  };

  it("is unknown when the answer never came after the request went, or the host says it may have gone", async () => {
    expect(await failure(new TimeoutError("work.messages.send", 30_000))).toEqual({ words: "It may have gone: the host did not answer", unknown: true });
    expect(await failure(new ConnectionLostError("connection closed"))).toEqual({ words: "It may have gone: the host did not answer", unknown: true });
    expect(await failure(new Error("It may have gone: socket hang up"))).toEqual({ words: "It may have gone: socket hang up", unknown: true });
  });

  it("is a plain refusal when LifeOS said no, or the link was down before the request went", async () => {
    expect(await failure(new Error("Your Mac isn't running LifeOS"))).toEqual({ words: "Your Mac isn't running LifeOS", unknown: false });
    expect(await failure(new ConnectionLostError("not connected"))).toEqual({ words: "Not connected", unknown: false });
  });
});

describe("a draft's Discard", () => {
  it("is refused, not taken, for a held draft the Outbox's list no longer holds", async () => {
    const link = fakeLink(() => Promise.resolve({}));
    await expect((await data()).dropDraft({ id: "gone", held: true, text: "x", threadId: null })).rejects.toThrow("This draft is no longer waiting");
    expect(link.request).not.toHaveBeenCalledWith("work.outbox.discard", expect.anything());
  });
});

describe("the copy-only drafts", () => {
  it("are asked for again when the link opens, after a read that failed while it was down", async () => {
    let up = false;
    const link = fakeLink((method) =>
      method !== "work.messages.drafts" ? Promise.resolve({ items: [], waiting: 0, grants: [] }) : up ? Promise.resolve({ drafts: [{ id: "md_1", chatId: "c1", sessionId: null, text: "Clip 3.", at: 1 }] }) : Promise.reject(new ConnectionLostError("not connected")),
    );
    const live = await data("ws-reopen");
    const { result } = renderHook(() => live.useDrafts("c1"));
    await flush();
    expect(result.current).toEqual([]);
    up = true;
    await act(async () => link.opens.forEach((fn) => fn()));
    await flush();
    expect(result.current.map((d) => d.text)).toEqual(["Clip 3."]);
  });
});

describe("a file opened beside the conversation", () => {
  it("says the host's refusal rather than looking dead", async () => {
    fakeLink(() => Promise.resolve({}));
    const file: ChatFile = { _id: "f1", name: "spec.pdf", contentType: "application/pdf", status: "stored", url: "https://lifeos.test/x" };
    (await data()).openFile("c1", "m1", file);
    await flush();
    expect(seen.opens).toBe(1);
    expect(seen.toasts).toEqual(["error: The host is away"]);
  });
});
