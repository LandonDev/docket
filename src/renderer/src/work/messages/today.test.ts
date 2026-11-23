import { describe, expect, it, vi } from "vitest";
import type { ChatWaiting } from "@shared/work/messages";
import type { TodayWorkspace } from "../today/types";

const went = vi.hoisted(() => [] as unknown[]);
vi.mock("../today/open", () => ({ goTo: (workspace: unknown, target: unknown) => void went.push([workspace, target]) }));
vi.mock("../today/read", () => ({ useEachWorkspace: () => ({ answers: [], loading: false, failed: [] }) }));

const { chatKey, source, waitingRows } = await import("./today");
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
      ["chat:c2", "Omar Reyes in #builds", "Second pad still drops", "2:59 PM", "cosmic"],
      ["chat:c1", "Dana Lee", "Can you look at the cut?", "2:00 PM", "cosmic"],
      ["chat:c3", "Marcus Bell in Ref crew", "Can you look at the cut?", "Saturday", "hypixel"],
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
    expect(rows.map((r) => r.key)).toEqual([chatKey("c1"), chatKey("c1")]);
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
});
