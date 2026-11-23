// @vitest-environment jsdom
/**
 * Who hears a key (docs/agents/work-editors.md): with the caret in a
 * document, ⌘B is the editor's bold and ⌘K its link, not the app's Sidebar
 * and Search. The window's capture listener is App.tsx's, built from the
 * same resolver; the editor is work-kit's own, mounted with no adapters.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentEditor, EditorKitProvider, type AnyEditor } from "work-kit/editor";
import { TextSelection } from "prosemirror-state";
import { createKeyResolver, type AppCommand } from "../../lib/appCommands";

afterEach(cleanup);

// jsdom lays nothing out: the selection bar asks a range for its rectangles when words are chosen.
const NO_RECTS = Object.assign([], { item: () => null }) as unknown as DOMRectList;
const NO_RECT = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
Range.prototype.getClientRects = () => NO_RECTS;
Range.prototype.getBoundingClientRect = () => NO_RECT;

/** The window's key listener as App.tsx mounts it: a resolved command is run and the key stops there. */
function appKeys(): { ran: AppCommand[]; off(): void } {
  const ran: AppCommand[] = [];
  const resolve = createKeyResolver();
  const onKey = (e: KeyboardEvent): void => {
    const cmd = resolve(e, { lightboxOpen: false });
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    ran.push(cmd);
  };
  window.addEventListener("keydown", onKey, true);
  return { ran, off: () => window.removeEventListener("keydown", onKey, true) };
}

async function mount(keys: string | null): Promise<{ editor: AnyEditor; text: HTMLElement }> {
  let editor: AnyEditor | null = null;
  const view = render(
    <EditorKitProvider value={{}}>
      <div {...(keys === null ? {} : { "data-editor-keys": keys })}>
        <DocumentEditor documentName={`doc.keys-${Math.random().toString(36).slice(2)}`} editable initialMarkdown="Setup starts at eight." onEditor={(e) => (editor = e)} />
      </div>
    </EditorKitProvider>,
  );
  await vi.waitFor(() => expect(editor).not.toBeNull(), { timeout: 5000 });
  await vi.waitFor(() => expect(view.container.querySelector("[contenteditable=true]")).not.toBeNull(), { timeout: 5000 });
  const text = view.container.querySelector<HTMLElement>("[contenteditable=true]")!;
  await vi.waitFor(() => expect(text.textContent).toContain("Setup starts"), { timeout: 5000 });
  return { editor: editor!, text };
}

/** Chooses the document's first word. */
function chooseFirstWord(editor: AnyEditor): void {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.startsWith("Setup")) at = pos;
  });
  expect(at).toBeGreaterThan(-1);
  editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, at, at + 5)));
}

const press = (el: HTMLElement, key: string): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, bubbles: true, cancelable: true });
  act(() => void el.dispatchEvent(event));
  return event;
};

const boldWords = (editor: AnyEditor): string[] => {
  const out: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.isText && node.marks.some((m) => m.type.name === "bold")) out.push(node.text ?? "");
  });
  return out;
};

describe("the caret in a document", () => {
  it("⌘B makes the chosen words bold and leaves the sidebar alone", async () => {
    const app = appKeys();
    const { editor, text } = await mount("document");
    chooseFirstWord(editor);
    press(text, "b");
    expect(boldWords(editor)).toEqual(["Setup"]);
    expect(app.ran).toEqual([]);
    app.off();
  });

  it("without the editor's mark, as before this rule, ⌘B was the sidebar's and nothing went bold", async () => {
    const app = appKeys();
    const { editor, text } = await mount(null);
    chooseFirstWord(editor);
    press(text, "b");
    expect(app.ran).toEqual([{ id: "toggle_sidebar" }]);
    expect(boldWords(editor)).toEqual([]);
    app.off();
  });

  it("⌘K reaches the editor, not Search", async () => {
    const app = appKeys();
    const { editor, text } = await mount("document");
    chooseFirstWord(editor);
    const heard: string[] = [];
    text.addEventListener("keydown", (e) => heard.push(e.key));
    press(text, "k");
    expect(heard).toEqual(["k"]);
    expect(app.ran).toEqual([]);
    app.off();
  });

  it("in a document he can only read, ⌘B and ⌘K stay the app's", async () => {
    const app = appKeys();
    const { text } = await mount("read");
    press(text, "b");
    press(text, "k");
    expect(app.ran).toEqual([{ id: "toggle_sidebar" }, { id: "open_search" }]);
    app.off();
  });
});
