// @vitest-environment jsdom
/**
 * Preview as a state of the document (docs/DESIGN.md "Work editors:
 * Preview"; docs/agents/work-docs.md "Preview"): Export… in the pane's More,
 * File → Export… and ⇧⌘E all open it over the editor, which stays mounted
 * under it, out of reach, with its place kept; Edit puts him back in the
 * words. The editor and the frame are stand-ins here: each has its own test.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem } from "@shared/work";
import type { CanvasShell, MoreEntry } from "../canvas/kind";

const FILE = { at: "file", host: "box", path: "/w/Run of show.tcdoc" } as const;
const opened = vi.hoisted(() => ({ role: "edit" as "edit" | "view", focused: 0, editors: 0, schema: 1 as number | undefined, props: [] as Record<string, unknown>[], lead: "" }));

vi.mock("./host", () => ({
  docHost: (env: string) => ({
    env,
    open: async () => ({ doc: "file:abc", source: { at: "file", host: "box", path: "/w/Run of show.tcdoc" }, title: "Run of show", role: opened.role, shared: false, mode: "writes", written: null, me: "owner", names: { owner: "You" }, ...(opened.schema === undefined ? {} : { schema: opened.schema }) }),
    token: async () => ({ token: "t", expiresAt: 0 }),
    threads: async () => ({ rows: [], names: {} }),
    onPush: () => () => undefined,
    socket: class {},
  }),
  servedBy: () => null,
}));
vi.mock("../../lib/connection", () => ({
  registry: { onLink: () => () => undefined, linkOf: () => ({ request: async () => ({ branches: [], names: {} }), onPush: () => () => undefined }) },
}));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ error: () => undefined }) }));
vi.mock("work-kit/editor", async (original) => {
  const { useEffect } = await import("react");
  return {
    ...(await original<typeof import("work-kit/editor")>()),
    // The shared editor, standing in: it hands the body an editor as the real one does.
    DocumentEditor: (props: { onEditor?(editor: unknown): void; editable?: boolean } & Record<string, unknown>) => {
      const { onEditor, editable } = props;
      opened.props.push(props);
      useEffect(() => {
        opened.editors++;
        // The first block's words, as the real editor's state holds them (doc > group > block > content).
        const lead = { doc: { firstChild: { firstChild: { firstChild: { textContent: opened.lead } } } } };
        onEditor?.({ document: [], domElement: document.createElement("div"), focus: () => void opened.focused++, onChange: () => () => undefined, prosemirrorState: lead });
        return () => onEditor?.(null);
      }, [onEditor]);
      return <div data-fake-editor contentEditable={editable} tabIndex={0} suppressContentEditableWarning />;
    },
  };
});
const previews = vi.hoisted(() => [] as Array<{ kind: string; title: string; readOnly?: boolean; initial?: string; formats: string[]; source: unknown; onClose(): void }>);
const frames = vi.hoisted(() => ({ mounted: 0 }));
vi.mock("../formats/PreviewFrame", async () => {
  const { useEffect } = await import("react");
  return {
  Preview: (props: { kind: string; title: string; readOnly?: boolean; initial?: string; source: { formats: { id: string }[] }; onClose(): void }) => {
    // A frame mounted anew starts on the format it was asked for; one that only renders again does not.
    useEffect(() => void frames.mounted++, []);
    previews.push({ kind: props.kind, title: props.title, ...(props.readOnly !== undefined ? { readOnly: props.readOnly } : {}), ...(props.initial ? { initial: props.initial } : {}), formats: props.source.formats.map((f) => f.id), source: props.source, onClose: props.onClose });
    return <div data-fake-preview>Preview of {props.title}</div>;
  },
  };
});

const { workCommands } = await import("../../lib/appCommands");
const { Body } = await import("./DocumentCanvas");

afterEach(() => {
  cleanup();
  previews.length = 0;
  opened.role = "edit";
  opened.schema = 1;
  opened.props.length = 0;
  opened.focused = 0;
  opened.editors = 0;
  opened.lead = "";
});

const ITEM = { id: "d1", sessionId: "t1", kind: "document", title: "Run of show", source: FILE } as CanvasItem;

async function mount() {
  let more: MoreEntry[] = [];
  const shell = { statusLine: () => {}, ready: () => {}, more: (rows: MoreEntry[] | null) => void (more = rows ?? []), mode: () => {}, written: () => {}, review: () => {}, presence: () => {}, ask: () => {} } as unknown as CanvasShell;
  const view = render(<Body item={ITEM} source={FILE} env="box" state={undefined} setState={() => {}} shell={shell} />);
  await waitFor(() => expect(view.container.querySelector("[data-fake-editor]")).not.toBeNull());
  await waitFor(() => expect(more.some((row) => row.id === "export")).toBe(true));
  return { ...view, more: () => more };
}

const slot = (): HTMLElement | null => document.querySelector("[data-doc-preview]");
const under = (): HTMLElement => document.querySelector<HTMLElement>("[data-doc-scroller]")!.parentElement!;

describe("Preview, a state of the document", () => {
  it("Export… in the pane's More opens it over the editor, which stays mounted, unseen and out of reach", async () => {
    const view = await mount();
    expect(slot()).toBeNull();
    expect(under().hasAttribute("inert")).toBe(false);
    expect(view.more().find((row) => row.id === "export")!.label).toBe("Export…");
    await act(async () => view.more().find((row) => row.id === "export")!.run());
    expect(screen.getByText("Preview of Run of show")).toBeTruthy();
    expect(slot()!.contains(document.querySelector("[data-fake-preview]"))).toBe(true);
    expect(slot()!.className).toContain("absolute inset-0");
    // The same editor, not a new one: its text, its caret and its place are kept.
    expect(view.container.querySelector("[data-fake-editor]")).not.toBeNull();
    expect(opened.editors).toBe(1);
    expect(under().hasAttribute("inert")).toBe(true);
    expect(under().className).toContain("invisible");
    expect(previews.at(-1)).toMatchObject({ kind: "document", title: "Run of show", readOnly: false, formats: ["docx", "pdf", "print", "md", "html", "odt", "rtf"] });
    // Export… opens on the format he last used, not on one it names.
    expect(previews.at(-1)!.initial).toBeUndefined();
  });

  it("File → Export… and ⇧⌘E open it too, and Edit puts him back in the words", async () => {
    await mount();
    expect(workCommands.has("export")).toBe(true);
    await act(async () => void workCommands.run("export"));
    expect(slot()).not.toBeNull();
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((run) => (run(0), 0));
    await act(async () => previews.at(-1)!.onClose());
    expect(slot()).toBeNull();
    expect(under().hasAttribute("inert")).toBe(false);
    expect(opened.focused).toBe(1);
    expect(opened.editors).toBe(1);
    raf.mockRestore();
  });

  it("File → Print… and ⌘P open it on Print, and move it there when it is already up on another format", async () => {
    await mount();
    // The document answers Print: the menu's row is live, and ⌘P is Print while the caret is in it.
    expect(workCommands.has("print")).toBe(true);
    const root = document.querySelector("[data-editor-answers]")!;
    expect(root.getAttribute("data-editor-answers")).toBe("export find print");
    expect(root.contains(document.querySelector("[data-editor-keys]"))).toBe(true);
    await act(async () => void workCommands.run("print"));
    expect(previews.at(-1)).toMatchObject({ kind: "document", initial: "print" });
    cleanup();
    previews.length = 0;

    await mount();
    await act(async () => void workCommands.run("export"));
    const before = previews.length;
    expect(previews.at(-1)!.initial).toBeUndefined();
    await act(async () => void workCommands.run("print"));
    expect(previews.length).toBeGreaterThan(before);
    expect(previews.at(-1)!.initial).toBe("print");
    expect(document.querySelectorAll("[data-fake-preview]")).toHaveLength(1);
  });

  it("each ask is a frame of its own: ⌘P again, after he moved to another format inside Preview, is Print again", async () => {
    await mount();
    frames.mounted = 0;
    await act(async () => void workCommands.run("print"));
    expect(frames.mounted).toBe(1);
    // He picks PDF inside the frame (the body cannot see that), then presses ⌘P: a new frame, on Print.
    await act(async () => void workCommands.run("print"));
    expect(frames.mounted).toBe(2);
    expect(previews.at(-1)!.initial).toBe("print");
    await act(async () => void workCommands.run("export"));
    expect(frames.mounted).toBe(3);
    expect(previews.at(-1)!.initial).toBeUndefined();
    expect(document.querySelectorAll("[data-fake-preview]")).toHaveLength(1);
  });

  it("the format row is the body's first, unscrolled row on a document he may edit: the editor draws it into the body's own place, and its Preview is this one", async () => {
    await mount();
    const row = document.querySelector<HTMLElement>("[data-doc-row]")!;
    // Above the scroller, inside the body, with the editor's own keys while focus is in it.
    expect(row.nextElementSibling!.contains(document.querySelector("[data-doc-scroller]"))).toBe(true);
    expect(row.getAttribute("data-editor-keys")).toBe("document");
    await waitFor(() => expect(opened.props.at(-1)!.formatRowInto).toBe(row));
    expect(opened.props.at(-1)!.formatRow).toBe(true);
    expect(opened.props.at(-1)!.hostSchema).toBe(1);
    expect(["Letter", "A4"]).toContain(opened.props.at(-1)!.paper);
    // The row's way out opens Preview on the format he last used.
    await act(async () => (opened.props.at(-1)!.onPreview as () => void)());
    expect(slot()).not.toBeNull();
    expect(previews.at(-1)!.initial).toBeUndefined();
    // Under Preview the row is out of sight and reach with the editor.
    expect(row.hasAttribute("inert")).toBe(true);
  });

  it("Edit → Find… and ⌘F open the editor's own find: the body answers find and hands the command to the editor's handle", async () => {
    await mount();
    const props = opened.props.at(-1)!;
    expect(props.find).toBe(true);
    // The body says it answers find, so ⌘F is the editor's while the caret is in it (work-editors.md "Who hears a key").
    expect(document.querySelector("[data-editor-answers]")!.getAttribute("data-editor-answers")!.split(" ")).toContain("find");
    const asked: (boolean | undefined)[] = [];
    await act(async () => (props.onFind as (handle: unknown) => void)({ open: (withReplace?: boolean) => void asked.push(withReplace), close: () => {} }));
    await act(async () => workCommands.run("find"));
    expect(asked).toEqual([undefined]);
    // The editor gone (its handle null), the command does nothing and throws nothing.
    await act(async () => (props.onFind as (handle: unknown) => void)(null));
    await act(async () => workCommands.run("find"));
    expect(asked).toHaveLength(1);
  });

  it("the column says the file's name over the text, unless the text's first line is that name", async () => {
    opened.lead = "Setup starts at 8:00";
    const first = await mount();
    await waitFor(() => expect(first.container.querySelector("h1")?.textContent).toBe("Run of show"));
    cleanup();
    // A Word file's own Title line, in any case and spacing: the name is not said twice.
    opened.lead = "  run of   SHOW ";
    const second = await mount();
    await waitFor(() => expect(second.container.querySelector("h1")).toBeNull());
  });

  it("a host from before the schema gate says no schema: the editor is told 0 and offers nothing newer", async () => {
    opened.schema = undefined;
    await mount();
    await waitFor(() => expect(opened.props.at(-1)?.hostSchema).toBe(0));
  });

  it("a document he can only read has no format row, and previews the same way, with the way out reading Back", async () => {
    opened.role = "view";
    const view = await mount();
    await act(async () => view.more().find((row) => row.id === "export")!.run());
    expect(previews.at(-1)).toMatchObject({ readOnly: true });
    expect(opened.props.at(-1)).not.toHaveProperty("formatRow");
  });

  it("hands the frame one source for as long as the document is the same, so a redraw of the body draws nothing again", async () => {
    const view = await mount();
    await act(async () => view.more().find((row) => row.id === "export")!.run());
    const first = previews.length;
    view.rerender(<Body item={{ ...ITEM, title: "Run of show" }} source={FILE} env="box" state={{ scrollTop: 4 }} setState={() => {}} shell={{ statusLine: () => {}, ready: () => {}, more: () => {}, mode: () => {}, written: () => {}, review: () => {}, presence: () => {}, ask: () => {} } as unknown as CanvasShell} />);
    await act(async () => {});
    expect(slot()).not.toBeNull();
    // The frame draws a new source as a new file: the body's own renders must not make one.
    expect(previews.length).toBeGreaterThan(first);
    expect(new Set(previews.map((p) => p.source)).size).toBe(1);
    expect(opened.editors).toBe(1);
  });

  it("goes when the document goes", async () => {
    const view = await mount();
    await act(async () => view.more().find((row) => row.id === "export")!.run());
    view.unmount();
    expect(workCommands.has("export")).toBe(false);
    expect(document.querySelector("[data-fake-preview]")).toBeNull();
  });
});
