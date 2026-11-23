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
const opened = vi.hoisted(() => ({ role: "edit" as "edit" | "view", focused: 0, editors: 0 }));

vi.mock("./host", () => ({
  docHost: (env: string) => ({
    env,
    open: async () => ({ doc: "file:abc", source: { at: "file", host: "box", path: "/w/Run of show.tcdoc" }, title: "Run of show", role: opened.role, shared: false, mode: "writes", written: null, me: "owner", names: { owner: "You" } }),
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
    DocumentEditor: ({ onEditor, editable }: { onEditor?(editor: unknown): void; editable?: boolean }) => {
      useEffect(() => {
        opened.editors++;
        onEditor?.({ document: [], domElement: document.createElement("div"), focus: () => void opened.focused++, onChange: () => () => undefined });
        return () => onEditor?.(null);
      }, [onEditor]);
      return <div data-fake-editor contentEditable={editable} tabIndex={0} suppressContentEditableWarning />;
    },
  };
});
const previews = vi.hoisted(() => [] as Array<{ kind: string; title: string; readOnly?: boolean; formats: string[]; source: unknown; onClose(): void }>);
vi.mock("../formats/PreviewFrame", () => ({
  Preview: (props: { kind: string; title: string; readOnly?: boolean; source: { formats: { id: string }[] }; onClose(): void }) => {
    previews.push({ kind: props.kind, title: props.title, ...(props.readOnly !== undefined ? { readOnly: props.readOnly } : {}), formats: props.source.formats.map((f) => f.id), source: props.source, onClose: props.onClose });
    return <div data-fake-preview>Preview of {props.title}</div>;
  },
}));

const { workCommands } = await import("../../lib/appCommands");
const { Body } = await import("./DocumentCanvas");

afterEach(() => {
  cleanup();
  previews.length = 0;
  opened.role = "edit";
  opened.focused = 0;
  opened.editors = 0;
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
    expect(previews.at(-1)).toMatchObject({ kind: "document", title: "Run of show", readOnly: false, formats: ["docx", "pdf", "md", "html", "odt", "rtf"] });
  });

  it("File → Export… and ⇧⌘E open it too, and Edit puts him back in the words", async () => {
    await mount();
    expect(workCommands.has("export")).toBe(true);
    // No Print until the document can print: the menu's row stays greyed and ⌘P stays Go to File.
    expect(workCommands.has("print")).toBe(false);
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

  it("a document he can only read previews the same way, with the way out reading Back", async () => {
    opened.role = "view";
    const view = await mount();
    await act(async () => view.more().find((row) => row.id === "export")!.run());
    expect(previews.at(-1)).toMatchObject({ readOnly: true });
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
