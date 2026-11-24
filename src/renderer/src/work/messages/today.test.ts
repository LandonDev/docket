import { describe, expect, it, vi } from "vitest";
import type { ChatWaiting } from "@shared/work/messages";
import type { TodayWorkspace } from "../today/types";

const went = vi.hoisted(() => [] as unknown[]);
vi.mock("../today/open", () => ({ goTo: (workspace: unknown, target: unknown) => void went.push([workspace, target]) }));
vi.mock("../today/read", () => ({ useEachWorkspace: () => ({ answers: [], loading: false, failed: [] }) }));
const toasts = vi.hoisted(() => [] as unknown[][]);
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ error: (...args: unknown[]) => void toasts.push(args) }) }));

const { chatKey, markChatRead, source, waitingRows } = await import("./today");
const { fedOf, putAnswer, resetToday, todayNow } = await import("../today/store");
const { page } = await import("../today/model");
const shownKeys = (): string[] => {
  const p = page(fedOf(todayNow()), { jobs: [{ environmentId: "box", workspaceId: "ws-a", sector: "cosmic", name: "Cosmic", path: "/w", open: true }], lifeos: "ok", gone: todayNow().gone });
  return p.kind === "day" ? p.keys : [];
};
const { TODAY_SOURCES } = await import("../today/sources");

/** Messages on Today: the conversations that wait on his answer, from every job. Made-up people. */

const now = new Date(2026, 10, 23, 15, 0).getTime();
const job = (workspaceId: string, sector: string, environmentId = "box"): TodayWorkspace => ({ environmentId, workspaceId, sector, name: sector, path: `/work/${workspaceId}`, open: true });
const chat = (chatId: string, over: Partial<ChatWaiting> = {}): ChatWaiting => ({ chatId, chat: "Dana Lee", who: "Dana Lee", text: "Can you look at the cut?", at: now - 3_600_000, source: "slack", ...over });

describe("Messages on Today", () => {
  it("is a section of its own, after what waits on his press and before files", async () => {
    expect(source.section).toMatchObject({ id: "messages", title: "Messages", order: 45, empty: "No one is waiting on a reply", lifeos: true });
    expect(TODAY_SOURCES.map((s) => s.id)).toContain("messages");
    expect((await TODAY_SOURCES.find((s) => s.id === "messages")!.load()).source).toBe(source);
  });

  it("lists every job's waiting conversations newest first, saying who wrote and where", () => {
    const rows = waitingRows(
      [
        { workspace: job("ws-a", "cosmic"), value: { rows: [chat("c1"), chat("c2", { chat: "#builds", who: "Omar Reyes", text: "Second pad still drops", at: now - 60_000 })] } },
        { workspace: job("ws-b", "hypixel"), value: { rows: [chat("c3", { chat: "Ref crew", who: "Marcus Bell", at: now - 2 * 86_400_000, source: "imessage" })] } },
      ],
      now,
      () => {},
    );
    expect(rows.map((r) => [r.key, r.title, r.detail, r.when, r.sector])).toEqual([
      [`chat:c2:${now - 60_000}`, "Omar Reyes in #builds", "Second pad still drops", "2:59 PM", "cosmic"],
      [`chat:c1:${now - 3_600_000}`, "Dana Lee", "Can you look at the cut?", "2:00 PM", "cosmic"],
      [`chat:c3:${now - 2 * 86_400_000}`, "Marcus Bell in Ref crew", "Can you look at the cut?", "Sat", "hypixel"],
    ]);
    // The section orders by `at` ascending: the newest carries the least.
    expect(rows.map((r) => r.at)).toEqual([...rows.map((r) => r.at)].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(rows.every((r) => r.section === "messages")).toBe(true);
  });

  it("keys a conversation once, whichever host answered for it", () => {
    const rows = waitingRows(
      [
        { workspace: job("ws-a", "cosmic", "box"), value: { rows: [chat("c1")] } },
        { workspace: job("ws-a2", "cosmic", "mac"), value: { rows: [chat("c1")] } },
      ],
      now,
      () => {},
    );
    expect(rows.map((r) => r.key)).toEqual([chatKey("c1", now - 3_600_000), chatKey("c1", now - 3_600_000)]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(1);
  });

  it("opens the conversation in its job's Messages view, and offers Mark read", async () => {
    const read: string[] = [];
    const [row] = waitingRows([{ workspace: job("ws-a", "cosmic"), value: { rows: [chat("c1")] } }], now, (id) => void read.push(id));
    row!.open();
    expect(went).toEqual([[expect.objectContaining({ workspaceId: "ws-a" }), { view: "messages", chat: "c1" }]]);
    expect(row!.acts?.map((a) => a.label)).toEqual(["Mark read"]);
    await row!.acts![0]!.run();
    expect(read).toEqual(["c1"]);
  });

  it("a message that comes after the one he marked read shows, with or without an empty answer between", async () => {
    vi.useFakeTimers();
    try {
      for (const between of [false, true]) {
        resetToday([source]);
        const rowsAt = (at: number) => waitingRows([{ workspace: job("ws-a", "cosmic"), value: { rows: [chat("c1", { at })] } }], now, () => {});
        putAnswer("messages", { rows: rowsAt(now - 60_000) });
        await markChatRead({ mutation: async () => null } as never, "c1", now - 60_000);
        if (between) putAnswer("messages", { rows: [] });
        // The row's fade and its closing place run out.
        await vi.advanceTimersByTimeAsync(1_000);
        // The host's next answer holds the conversation again, with a newer message in it.
        putAnswer("messages", { rows: rowsAt(now) });
        expect(shownKeys(), String(between)).toEqual([chatKey("c1", now)]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the very workspace its host answered for", () => {
    const [row] = waitingRows([{ workspace: { ...job("ws-a", "cosmic", "mac"), name: "Cosmic (Mac)" }, value: { rows: [chat("c1")] } }], now, () => {});
    expect(row!.job).toBe("Cosmic (Mac)");
  });

  it("Mark read takes the row off as his act, and puts it back with a counted toast when the write fails", async () => {
    resetToday([]);
    const mutation = vi.fn(async () => null);
    await markChatRead({ mutation } as never, "c1", 1);
    expect(mutation).toHaveBeenCalledWith(expect.anything(), { id: "c1" });
    expect(todayNow().leaving.has(chatKey("c1", 1))).toBe(true);
    resetToday([]);
    await markChatRead({ mutation: async () => Promise.reject(new Error("no")) } as never, "c2", 1);
    expect(todayNow().leaving.has(chatKey("c2", 1))).toBe(false);
    expect(toasts.at(-1)?.[0]).toBe("Couldn't mark it read");
    // Counted while it is up, so a narrow column gives it its strip.
    expect(todayNow().toastsUp).toBe(1);
    expect(toasts.at(-1)?.[1]).toMatchObject({ onDismiss: expect.any(Function), onAutoClose: expect.any(Function) });
  });
});
