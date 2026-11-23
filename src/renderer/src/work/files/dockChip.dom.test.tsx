// @vitest-environment jsdom
/**
 * The file's chip on the docked draft (dockThread.ts, docs/agents/work-files.md "Ask"): it is on the composer from
 * the first Ask of a tab, it is put back when the dock shows a draft that lost it, never when he took it off, and the
 * first send opens the file in the new thread only while the chip was on the composer when he sent.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTab } from "@shared/contract-work-files";
import type { CanvasItem } from "@shared/work";

const opened = vi.hoisted(() => [] as { sessionId: string; title: string }[]);
vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({ environmentId: id, connected: true, request: async (method: string) => (method === "work.files.threads" ? { threads: [] } : {}), onPush: () => () => undefined });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: () => true, environments: () => [], onLink: () => () => undefined } };
});
vi.mock("../canvas/store", async (original) => ({
  ...(await original<typeof import("../canvas/store")>()),
  openItem: async (_env: string, sessionId: string, what: { title: string }) => void opened.push({ sessionId, title: what.title }),
}));
vi.mock("../../surfaces/threadChat", () => ({
  useSessionActions: () => ({}),
  useThreadChat: () => ({ renderChat: () => null, renderSlots: () => null, newPassArmed: false, armNewPass: () => undefined }),
}));
// The thread's view: a stand-in whose composer shows its chips.
vi.mock("../../surfaces/threads/ThreadView", async () => {
  const { useContextChips } = await import("../canvas/chips");
  return {
    ThreadView: ({ session }: { session: { id: string } }) => {
      const chips = useContextChips(session.id);
      return <ul aria-label="Chips">{chips.map((c) => <li key={`${c.kind}:${c.label}`}>{c.label}</li>)}</ul>;
    },
  };
});
vi.mock("../../surfaces/SessionPane", () => ({ LoadLine: () => null }));

const { Dock } = await import("./Dock");
const { resetDocks } = await import("./dockThread");
const { removeContextChip, resetContextChips, takeContextChips } = await import("../canvas/chips");
const { sessionStore } = await import("../../lib/tcserver/store");
const { newSession } = await import("../../lib/session");
const { workDockPort } = await import("../../lib/workSwitch");
const { afterCreate } = await import("../../lib/tcserver/commands");

const workspace = { id: "w1", environmentId: "box", path: "/w" };
const tab: FileTab = { id: "t1", kind: "file", name: "Notes.txt", itemId: "i1" };
const item = { id: "i1", sessionId: "filespane_w1", workspaceId: "w1", kind: "file", title: "Notes.txt", source: { at: "file", host: "env_box", path: "/w/Notes.txt" }, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 } as CanvasItem;

beforeEach(() => {
  sessionStore.reset();
  resetContextChips();
  resetDocks();
  opened.length = 0;
  workDockPort.set({
    draft: (_ws, id) => ({ ...newSession("box", "claude", "/w", undefined, undefined, undefined, { projectId: null, workspaceId: "w1" }), ...(id ? { id } : {}) }),
    openFile: () => undefined,
    openDiff: () => undefined,
  });
});
afterEach(() => {
  cleanup();
  workDockPort.set(null);
});

const mount = () => render(<Dock workspace={workspace} tab={tab} item={item} chip={null} focus={false} onChipTaken={() => undefined} onClose={() => undefined} />);
const shown = (): string[] => [...document.querySelectorAll("[aria-label='Chips'] li")].map((li) => li.textContent ?? "");
const draftId = (): string => document.querySelector("[data-files-dock]")!.getAttribute("data-files-dock")!;

describe("the file's chip on the docked draft", () => {
  it("is on the composer at the first Ask of a tab, and the first send opens the file in the new thread", async () => {
    mount();
    await waitFor(() => expect(shown()).toEqual(["Notes.txt"]));
    const id = draftId();
    // The send takes the chips with the message; the step after the create still opens the file.
    act(() => void takeContextChips(id, true));
    await afterCreate.run(id);
    expect(opened).toEqual([{ sessionId: id, title: "Notes.txt" }]);
  });

  it("is put back when the dock shows a draft that lost it", async () => {
    const first = mount();
    await waitFor(() => expect(shown()).toEqual(["Notes.txt"]));
    first.unmount();
    // The chips the window kept are gone (not his doing); the dock shown again has the chip.
    resetContextChips();
    mount();
    await waitFor(() => expect(shown()).toEqual(["Notes.txt"]));
  });

  it("stays off once he took it off, through closing and opening the dock, and the first send then opens no file", async () => {
    const first = mount();
    await waitFor(() => expect(shown()).toEqual(["Notes.txt"]));
    const id = draftId();
    act(() => removeContextChip(id, 0));
    expect(shown()).toEqual([]);
    first.unmount();
    mount();
    await waitFor(() => expect(draftId()).toBe(id));
    expect(shown()).toEqual([]);
    act(() => void takeContextChips(id, true));
    await afterCreate.run(id);
    expect(opened).toEqual([]);
  });
});
