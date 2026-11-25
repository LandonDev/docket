// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasFlushPort } from "./canvasFlushPort";
import { flushFocusedEditor, registerEditorFlusher } from "./editorFlush";
import { itemOf, saveFocused, saveKeyPort } from "./saveKey";

const offs: (() => void)[] = [];
afterEach(() => {
  while (offs.length) offs.pop()!();
  document.body.innerHTML = "";
});

const pane = (id: string, inFiles = false): HTMLElement => {
  const root = document.createElement("div");
  root.innerHTML = inFiles ? `<div data-files-main><div data-canvas-item="${id}"><p tabindex="-1">text</p></div></div>` : `<div data-canvas-item="${id}"><p tabindex="-1">text</p></div>`;
  document.body.append(root);
  return root.querySelector("p")!;
};

describe("⌘S saves what holds the focus (decision 11)", () => {
  it("a code editor with the focus writes its buffer as his save, and no other editor writes", async () => {
    const a = vi.fn(async () => true);
    const b = vi.fn(async () => true);
    offs.push(registerEditorFlusher("/a.ts", a, () => false), registerEditorFlusher("/b.ts", b, () => true));
    expect(await saveFocused(null)).toBe("editor");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(true);
  });

  it("no code editor with the focus writes nothing: an editor with no focus test is never saved by the key", async () => {
    const a = vi.fn(async () => true);
    offs.push(registerEditorFlusher("/a.ts", a));
    expect(await flushFocusedEditor()).toBeNull();
    expect(await saveFocused(document.body)).toBe("none");
    expect(a).not.toHaveBeenCalled();
  });

  it("a Work file with the focus sends what its kind holds; a file of its own save runs that in its place", async () => {
    const sent = vi.fn(async () => undefined);
    const own = vi.fn(async () => undefined);
    offs.push(canvasFlushPort.set("i1", sent), canvasFlushPort.set("i2", sent));
    const p1 = pane("i1");
    expect(await saveFocused(p1)).toBe("item");
    expect(sent).toHaveBeenCalledTimes(1);
    offs.push(saveKeyPort.set("i2", own));
    expect(await saveFocused(pane("i2"))).toBe("item");
    expect(own).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("a send that fails is not thrown: the file's own line says it", async () => {
    offs.push(canvasFlushPort.set("i1", async () => Promise.reject(new Error("no answer in 8 s"))));
    expect(await saveFocused(pane("i1"))).toBe("item");
  });

  it("with the focus on nothing, the one file a Files tab shows; anywhere else, nothing", () => {
    expect(itemOf(document.body)).toBeNull();
    pane("i3", true);
    expect(itemOf(document.body)).toBe("i3");
    const composer = document.createElement("textarea");
    document.body.append(composer);
    expect(itemOf(composer)).toBeNull();
  });
});
