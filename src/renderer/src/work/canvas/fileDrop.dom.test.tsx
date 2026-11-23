// @vitest-environment jsdom
/**
 * Files dropped on Work (docs/agents/work-canvas.md "Opening a file from outside"):
 * where each drop opens, the wash over the place it would open in, the composer
 * keeping its own drops, and a file no kind shows offered as an attachment.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opens = vi.hoisted(() => [] as { place: unknown; files: { name: string }[] }[]);
vi.mock("./openOutside", () => ({
  openOutside: async (place: unknown, files: { name: string }[]) => void opens.push({ place, files }),
  outsideOf: (file: File) => ({ name: file.name }),
}));
vi.mock("../../lib/native", () => ({ getPathForFile: () => "" }));

import type { FileLook } from "../../lib/openFilePlace";
import { fileDropClaimed, openWorkView, workFilePort } from "../../lib/workSwitch";
import { DRAG_QUIET_MS, dropPlaceOf, FileDrops } from "./fileDrop";

/** t1 is a Work thread, c1 a code thread, d1 a Work workspace's draft, d2 a code workspace's, d3 a Work Chat's. */
const look: FileLook = {
  meta: (id) => ({ t1: { scope: "work" }, c1: { scope: null } })[id] ?? null,
  draft: (id) => ({ d1: { workspaceId: "w-work" }, d2: { workspaceId: "w-code" }, d3: { scope: "work" as const, workspaceId: null } })[id],
  provisional: () => false,
  workspaceKind: (id) => (id === "w-work" ? "work" : "code"),
};

function pane(id: string): HTMLElement {
  const root = document.createElement("div");
  root.dataset.sessionDrop = id;
  root.innerHTML = `
    <div data-board><div id="${id}-item"><div data-drop-import><p id="${id}-doc"></p></div></div></div>
    <div data-chat><p id="${id}-transcript"></p><div data-composer-box><textarea id="${id}-composer"></textarea></div></div>`;
  document.body.append(root);
  return root;
}
const at = (id: string): Element => document.getElementById(id)!;

beforeEach(() => {
  document.body.innerHTML = "";
  opens.length = 0;
});
afterEach(cleanup);

describe("where a drop opens", () => {
  it("a Work thread's or Work draft's pane but its composer, and a Work view; nothing of code", () => {
    for (const id of ["t1", "c1", "d1", "d2", "d3"]) pane(id);
    const view = document.createElement("div");
    view.dataset.fileOpens = "";
    view.innerHTML = `<p id="docs-row"></p>`;
    document.body.append(view);

    // A Work thread's: on its canvas or beside it, the wash on the canvas, where the file will show.
    for (const at_ of ["t1-item", "t1-transcript", "t1-doc"]) {
      const hit = dropPlaceOf(at(at_), look);
      expect(hit?.place).toEqual({ at: "thread", sessionId: "t1" });
      expect(hit?.zone.hasAttribute("data-board")).toBe(true);
    }
    // The composer attaches, as it always has.
    expect(dropPlaceOf(at("t1-composer"), look)).toBeNull();
    // A code thread is out of it.
    expect(dropPlaceOf(at("c1-item"), look)).toBeNull();
    // A Work draft is opened anywhere but its composer, and is made a thread first.
    expect(dropPlaceOf(at("d1-transcript"), look)).toEqual({ place: { at: "draft", sessionId: "d1" }, zone: at("d1-transcript").closest("[data-session-drop]") });
    expect(dropPlaceOf(at("d3-transcript"), look)?.place).toEqual({ at: "draft", sessionId: "d3" });
    expect(dropPlaceOf(at("d1-composer"), look)).toBeNull();
    expect(dropPlaceOf(at("d2-transcript"), look)).toBeNull();
    // A Work view starts a new thread.
    expect(dropPlaceOf(at("docs-row"), look)).toEqual({ place: { at: "new" }, zone: view });
  });
});

describe("the router", () => {
  const file = new File(["%PDF"], "Brief.pdf", { type: "application/pdf" });
  function filesEvent(type: string, target: Element): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file], dropEffect: "none" } });
    act(() => void target.dispatchEvent(event));
    return event;
  }

  it("washes the canvas under a file and opens the drop there, marked so the composer lets it pass", async () => {
    const root = pane("t1");
    const composerSaw: boolean[] = [];
    root.addEventListener("drop", (event) => composerSaw.push(fileDropClaimed(event)));
    render(<FileDrops look={look} />);

    const over = filesEvent("dragover", at("t1-transcript"));
    expect(over.defaultPrevented).toBe(true);
    expect(document.querySelector("[data-file-wash]")?.textContent).toBe("Drop to open");

    const drop = filesEvent("drop", at("t1-transcript"));
    expect(drop.defaultPrevented).toBe(true);
    expect(composerSaw).toEqual([true]);
    expect(document.querySelector("[data-file-wash]")).toBeNull();
    await vi.waitFor(() => expect(opens).toEqual([{ place: { at: "thread", sessionId: "t1" }, files: [{ name: "Brief.pdf" }] }]));
  });

  it("leaves a drop on the composer to the composer", () => {
    const root = pane("t1");
    const composerSaw: boolean[] = [];
    root.addEventListener("drop", (event) => composerSaw.push(fileDropClaimed(event)));
    render(<FileDrops look={look} />);
    filesEvent("dragover", at("t1-composer"));
    expect(document.querySelector("[data-file-wash]")).toBeNull();
    filesEvent("drop", at("t1-composer"));
    expect(composerSaw).toEqual([false]);
    expect(opens).toEqual([]);
  });

  it("leaves a file to a surface inside that takes it (Mail's composer, an empty meeting, a document)", async () => {
    pane("t1");
    for (const type of ["dragover", "drop"]) at("t1-doc").addEventListener(type, (event) => event.preventDefault());
    render(<FileDrops look={look} />);
    filesEvent("dragover", at("t1-doc"));
    expect(document.querySelector("[data-file-wash]")).toBeNull();
    filesEvent("drop", at("t1-doc"));
    await new Promise((done) => setTimeout(done, 10));
    expect(opens).toEqual([]);
  });

  it("takes the wash away when the drag goes quiet, as one that left the window does", () => {
    vi.useFakeTimers();
    try {
      pane("t1");
      render(<FileDrops look={look} />);
      filesEvent("dragover", at("t1-item"));
      expect(document.querySelector("[data-file-wash]")).toBeTruthy();
      act(() => void vi.advanceTimersByTime(DRAG_QUIET_MS + 10));
      expect(document.querySelector("[data-file-wash]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the File menu's Open File…", () => {
  it("is Work's while the router is mounted, and lit only with a Work place in front", () => {
    const view = render(<FileDrops look={look} />);
    expect(workFilePort.get()?.can()).toBe(false);
    openWorkView({ workspaceId: "w-work", view: "people" });
    expect(workFilePort.get()?.can()).toBe(true);
    openWorkView(null);
    view.unmount();
    expect(workFilePort.get()).toBeNull();
  });
});
