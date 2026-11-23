// @vitest-environment jsdom
/**
 * The chat docked beside a file taking several chips at once and a drop of Files rows (Dock.tsx, dockThread.ts
 * `addRowChips`): the composer gets a file chip each, with the place and path in words; past eight in all it takes
 * none and one toast says why; a drag that is not Files' own rows is not taken.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTab } from "@shared/contract-work-files";
import type { CanvasItem, ContextChip } from "@shared/work";
import type { FileEntry, FilePlace } from "@shared/work/files";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../components/ui/toaster", async (original) => ({
  ...(await original<typeof import("../../components/ui/toaster")>()),
  loadToast: async () => ({ message: (text: string) => void toasts.push(text), error: (text: string) => void toasts.push(text) }),
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
      return (
        <div data-testid="chat">
          <ul aria-label="Chips">{chips.map((c) => <li key={`${c.kind}:${c.label}`} data-kind={c.kind}>{c.label}</li>)}</ul>
          <textarea data-composer-input aria-label="Message" />
        </div>
      );
    },
  };
});
vi.mock("../../surfaces/SessionPane", () => ({ LoadLine: () => null }));

const { Dock } = await import("./Dock");
const { ROWS_MIME, setDragging } = await import("./rowParts");
const { contextChipsOf, resetContextChips } = await import("../canvas/chips");
const { sessionStore } = await import("../../lib/tcserver/store");
const { newSession } = await import("../../lib/session");

const workspace = { id: "w1", environmentId: "box" };
const tab: FileTab = { id: "t1", kind: "file", name: "Budget.xlsx", itemId: "i1" };
const item = { id: "i1", sessionId: "filespane_w1", workspaceId: "w1", kind: "sheet", title: "Budget.xlsx", source: { at: "file", host: "env_box", path: "/w/Budget.xlsx" }, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 } as CanvasItem;
const general: FilePlace = { id: "b1/General", kind: "teams", name: "General", host: "", env: "env_box", shared: true, can: [], state: { state: "ok" }, root: { at: "file", host: "env_box", path: "/cloud/Staff/General" } };
const row = (path: string): FileEntry => ({ key: `file:env_box:${path}`, ref: { at: "file", host: "env_box", path }, folder: null, name: path.split("/").pop()!, kind: "sheet" });
const chip = (label: string): ContextChip => ({ kind: "file", label, ref: { at: "file", host: "env_box", path: `/w/${label}` } });

let draftId = "";
beforeEach(() => {
  sessionStore.reset();
  resetContextChips();
  toasts.length = 0;
  const draft = newSession("box", "claude", "/w", undefined, undefined, undefined, { projectId: null, workspaceId: "w1" });
  draftId = draft.id;
  sessionStore.mutate((prev) => [...prev, draft]);
});
afterEach(() => {
  setDragging(null);
  cleanup();
});

function mount(chips: ContextChip | readonly ContextChip[] | null = null, onChipTaken = vi.fn()) {
  const view = render(<Dock workspace={workspace} tab={tab} item={item} chip={chips} focus={false} preset={{ id: draftId, draft: true }} onChipTaken={onChipTaken} onClose={() => undefined} />);
  return { ...view, onChipTaken, dock: view.container.querySelector("[data-files-dock]") as HTMLElement };
}
const shown = (): string[] => [...document.querySelectorAll("[aria-label='Chips'] li")].map((li) => li.textContent ?? "");
const rows = (types: string[] = [ROWS_MIME]) => ({ dataTransfer: { types, dropEffect: "none" } });

describe("the docked composer", () => {
  it("takes a list of chips for the first message, as it takes one", async () => {
    const { onChipTaken } = mount([chip("Budget.xlsx"), chip("Roster.xlsx")]);
    await waitFor(() => expect(shown()).toEqual(["Budget.xlsx", "Roster.xlsx"]));
    expect(onChipTaken).toHaveBeenCalledTimes(1);
  });

  it("takes Files rows dropped on it as a file chip each, under the wash while they are over it", async () => {
    const { dock } = mount();
    await waitFor(() => expect(shown()).toEqual([]));
    setDragging({ entries: [row("/cloud/Staff/General/Spring budget.xlsx"), row("/cloud/Staff/General/Budgets/2026.xlsx")], from: { place: general, link: "box", host: "The box", wire: "files" } });
    fireEvent.dragOver(dock, rows());
    expect(dock.querySelector("[data-rows-wash]")?.textContent).toBe("Drop to add to the message");
    fireEvent.drop(dock, rows());
    expect(dock.querySelector("[data-rows-wash]")).toBeNull();
    await waitFor(() => expect(shown()).toEqual(["Spring budget.xlsx", "2026.xlsx"]));
    expect(contextChipsOf(draftId).map((c) => [c.kind, c.where])).toEqual([
      ["file", { place: "b1/General", name: "General", path: "Spring budget.xlsx", shared: true }],
      ["file", { place: "b1/General", name: "General", path: "Budgets/2026.xlsx", shared: true }],
    ]);
  });

  it("takes none past eight in all, and says why once", async () => {
    const { dock } = mount([chip("a.xlsx"), chip("b.xlsx"), chip("c.xlsx")]);
    await waitFor(() => expect(shown()).toHaveLength(3));
    setDragging({ entries: Array.from({ length: 6 }, (_, i) => row(`/cloud/Staff/General/f${i}.xlsx`)), from: { place: general, link: "box", host: "The box", wire: "files" } });
    fireEvent.dragOver(dock, rows());
    fireEvent.drop(dock, rows());
    await waitFor(() => expect(toasts).toEqual(["A message can hold 8 files at most."]));
    expect(shown()).toHaveLength(3);
  });

  it("leaves a drag that is not Files' own rows alone", async () => {
    const { dock } = mount();
    await waitFor(() => expect(shown()).toEqual([]));
    // A desktop's files: the composer's own wash and attach, not a chip.
    fireEvent.dragOver(dock, rows(["Files"]));
    expect(dock.querySelector("[data-rows-wash]")).toBeNull();
    // The type with no rows in flight (another window's drag): nothing.
    fireEvent.dragOver(dock, rows());
    fireEvent.drop(dock, rows());
    expect(dock.querySelector("[data-rows-wash]")).toBeNull();
    expect(shown()).toEqual([]);
  });
});
