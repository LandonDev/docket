// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem } from "@shared/work";
import type { CanvasShell } from "../canvas/kind";

const requests: { env: string; method: string; params: Record<string, unknown> }[] = [];
let answer: (env: string, method: string) => Promise<unknown> = async () => ({});
vi.mock("../../lib/connection", () => ({
  registry: {
    linkOf: (env: string) => ({
      request: (method: string, params: Record<string, unknown>) => {
        requests.push({ env, method, params });
        return answer(env, method);
      },
    }),
  },
}));
const toasts: string[] = [];
vi.mock("../../components/ui/toaster", () => ({
  loadToast: async () => Object.assign((m: string) => void toasts.push(m), { error: (m: string) => void toasts.push(`error: ${m}`) }),
}));

import { DropImport, ImportBody } from "./Import";
import { fileStem, fromBase64, importable, importsFirst, paperFor, saveFile, toBase64, warningsLine } from "./model";

const SOURCE = { at: "file", host: "env_box", path: "/w/Plan.tcdoc" } as const;
const saved: { name: string; size: number }[] = [];

beforeEach(() => {
  requests.length = 0;
  toasts.length = 0;
  saved.length = 0;
  localStorage.clear();
  URL.createObjectURL = ((blob: Blob) => (saved.push({ name: "", size: blob.size }), "blob:x")) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    saved[saved.length - 1]!.name = this.download;
  };
});
afterEach(cleanup);

describe("the words and rules", () => {
  it("paper, names, sources and bytes", () => {
    expect(paperFor("en-US")).toBe("Letter");
    expect(paperFor("en-GB")).toBe("A4");
    expect(paperFor("zh-Hans-CN")).toBe("A4");
    // No region named: his paper, not A4 by the want of a suffix.
    expect(paperFor("en")).toBe("Letter");
    expect(paperFor("")).toBe("Letter");
    expect(fileStem('Q3: "plan"/draft')).toBe("Q3 plan draft");
    expect(importable("notes.MD")).toBe(true);
    expect(importable("photo.png")).toBe(false);
    expect(importsFirst({ at: "file", host: "h", path: "/a/b.docx" })).toBe(true);
    expect(importsFirst({ at: "file", host: "h", path: "/a/b.tcdoc" })).toBe(false);
    expect(importsFirst({ at: "microsoft", host: "h", app: "word", name: "b", ref: { kind: "path", path: "/b.docx" } })).toBe(true);
    const bytes = new Uint8Array([0, 1, 254, 255, 80]);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
    expect(warningsLine(["2 pictures left out"])).toBe("2 pictures left out.");
  });
});

describe("a file saved", () => {
  it("goes where downloads go, under its own name", () => {
    saveFile("Plan.docx", new Blob([new Uint8Array([1, 2, 3])]));
    expect(saved).toEqual([{ name: "Plan.docx", size: 3 }]);
  });
});

const shell = () => {
  const lines: unknown[] = [];
  const ready: boolean[] = [];
  return { lines, ready, shell: { statusLine: (l: unknown) => void lines.push(l), ready: (r: boolean) => void ready.push(r) } as unknown as CanvasShell };
};

describe("Import", () => {
  it("a Word file's item asks the host once to make it a document and to reopen the item on it", async () => {
    answer = async () => ({ source: { at: "file", host: "env_box", path: "/w/Plan.tcdoc" }, title: "Plan", itemId: "i2", warnings: [], outsiders: true });
    const s = shell();
    const item = { id: "i1", sessionId: "t1" } as CanvasItem;
    const word = { at: "file", host: "env_box", path: "/w/Plan.docx" } as const;
    render(<ImportBody item={item} source={word} env="env_box" state={undefined} setState={() => {}} shell={s.shell} />);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({ env: "env_box", method: "work.formats.import", params: { sessionId: "t1", itemId: "i1", from: { at: "source", source: word } } });
  });

  it("when it cannot, the centred failure says why with Retry, and the bones stop: a failure is not drawn as loading", async () => {
    let fail: (error: Error) => void = () => {};
    answer = () => new Promise((_, reject) => (fail = reject));
    const s = shell();
    const { container } = render(<ImportBody item={{ id: "i9", sessionId: "t1" } as CanvasItem} source={{ at: "file", host: "env_box", path: "/w/Gone.docx" }} env="env_box" state={undefined} setState={() => {}} shell={s.shell} />);
    expect(container.querySelector("[data-canvas-skeleton]")).not.toBeNull();
    // It becomes another item: no History for it meanwhile.
    expect(s.ready).toEqual([false]);
    await act(async () => fail(new Error("that file is not there any more")));
    const failed = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-canvas-failed]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(failed.textContent).toContain("Couldn't open this document");
    expect(failed.textContent).toContain("That file is not there any more");
    expect(within(failed).getByRole("button", { name: "Retry" })).toBeTruthy();
    // Never a red line over a blank pane.
    expect(s.lines.filter((l) => l?.tone === "failed")).toEqual([]);
    expect(container.querySelector("[data-canvas-skeleton]")).toBeNull();
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("keeps the failure in place on his Retry, never the bones, until the import answers", async () => {
    answer = () => Promise.reject(new Error("LibreOffice could not read it"));
    const s = shell();
    const { container } = render(<ImportBody item={{ id: "i6", sessionId: "t1" } as CanvasItem} source={{ at: "file", host: "env_box", path: "/w/Again.docx" }} env="env_box" state={undefined} setState={() => {}} shell={s.shell} />);
    await waitFor(() => expect(container.querySelector("[data-canvas-failed]")).not.toBeNull());
    let land: (v: unknown) => void = () => {};
    answer = () => new Promise((resolve) => (land = resolve));
    const asked = requests.length;
    fireEvent.click(within(container.querySelector<HTMLElement>("[data-canvas-failed]")!).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(requests.length).toBe(asked + 1));
    expect(container.querySelector("[data-canvas-failed]")).not.toBeNull();
    expect(container.querySelector("[data-canvas-skeleton]")).toBeNull();
    await act(async () => land({ source: { at: "file", host: "env_box", path: "/w/Again.tcdoc" }, title: "Again", itemId: "i6", warnings: [], outsiders: false }));
    await waitFor(() => expect(container.querySelector("[data-canvas-failed]")).toBeNull());
  });

  it("a file renamed while it imports is imported as itself, never answered with the old name's failure", async () => {
    let fail: (error: Error) => void = () => {};
    answer = () => new Promise((_, reject) => (fail = reject));
    const s = shell();
    const item = { id: "i7", sessionId: "t1" } as CanvasItem;
    const at = (path: string) => <ImportBody item={item} source={{ at: "file", host: "env_box", path }} env="env_box" state={undefined} setState={() => {}} shell={s.shell} />;
    const { rerender } = render(at("/w/Old name.docx"));
    await waitFor(() => expect(requests.at(-1)?.params).toMatchObject({ from: { source: { path: "/w/Old name.docx" } } }));
    answer = async () => ({ source: { at: "file", host: "env_box", path: "/w/New name.tcdoc" }, title: "New name", itemId: "i7", warnings: [], outsiders: false });
    rerender(at("/w/New name.docx"));
    await waitFor(() => expect(requests.at(-1)?.params).toMatchObject({ from: { source: { path: "/w/New name.docx" } } }));
    await act(async () => fail(new Error("that file is not there any more")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector("[data-canvas-failed]")).toBeNull();
  });

  it("a failed import is not run again when a canvas push hands the same file afresh", async () => {
    answer = () => Promise.reject(new Error("LibreOffice could not read it"));
    const s = shell();
    const item = { id: "i8", sessionId: "t1" } as CanvasItem;
    const at = (source: { at: "file"; host: string; path: string }) => <ImportBody item={item} source={source} env="env_box" state={undefined} setState={() => {}} shell={s.shell} />;
    const { rerender } = render(at({ at: "file", host: "env_box", path: "/w/Old.doc" }));
    await waitFor(() => expect(document.querySelector("[data-canvas-failed]")).not.toBeNull());
    const asked = requests.length;
    rerender(at({ at: "file", host: "env_box", path: "/w/Old.doc" }));
    rerender(at({ at: "file", host: "env_box", path: "/w/Old.doc" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests.length).toBe(asked);
    expect(document.querySelector("[data-canvas-failed]")).not.toBeNull();
  });

  it("a file dropped on a document opens as a document; a picture is left to the editor", async () => {
    // The upload answers as the host does: the file kept in the workspace's folder under its own name, then each import.
    let kept = 0;
    answer = async (_env, method) =>
      method === "attachment.begin"
        ? { uploadId: `u${++kept}`, chunkBytes: 2 * 1024 * 1024 }
        : method === "attachment.commit"
          ? { path: `/w/Brief${kept > 1 ? ` (${kept})` : ""}.docx` }
          : method === "attachment.chunk"
            ? null
            : { source: SOURCE, title: "Plan", itemId: "i3", warnings: [], outsiders: false };
    const imports = () => requests.filter((r) => r.method === "work.formats.import");
    render(
      <DropImport env="env_box" sessionId="t1" editor={null}>
        <p>text</p>
      </DropImport>,
    );
    const zone = document.querySelector("[data-drop-import]")!;
    const drop = (file: File) => fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [file] } });
    fireEvent.dragEnter(zone, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByText("Drop to open as a document")).toBeTruthy();
    await act(async () => drop(new File(["%PNG"], "photo.png")));
    expect(requests).toEqual([]);
    expect(toasts).toEqual([]);
    await act(async () => drop(new File([new Uint8Array([80, 75, 3, 4])], "Brief.docx")));
    await waitFor(() => expect(imports()).toHaveLength(1));
    // Its bytes go up in the upload's chunk, kept in the workspace's folder, and it is imported from there.
    expect(requests.map((r) => r.method)).toEqual(["attachment.begin", "attachment.chunk", "attachment.commit", "work.formats.import"]);
    expect(requests[1]!.params).toMatchObject({ uploadId: "u1", index: 0, dataBase64: toBase64(new Uint8Array([80, 75, 3, 4])) });
    expect(imports()[0]!.params).toEqual({ sessionId: "t1", from: { at: "source", source: { at: "file", host: "env_box", path: "/w/Brief.docx" } } });
    // A later file of the same name is another drop: it opens too, with its own bytes.
    await waitFor(() => expect(screen.queryByText("Opening Brief.docx")).toBeNull());
    await act(async () => drop(new File([new Uint8Array([80, 75, 3, 4, 9])], "Brief.docx")));
    await waitFor(() => expect(imports()).toHaveLength(2));
    expect(imports()[1]!.params).toEqual({ sessionId: "t1", from: { at: "source", source: { at: "file", host: "env_box", path: "/w/Brief (2).docx" } } });
  });
});
