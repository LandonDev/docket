// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("when it cannot, the state line says why with Retry, and the bones stop: a failure is not drawn as loading", async () => {
    let fail: (error: Error) => void = () => {};
    answer = () => new Promise((_, reject) => (fail = reject));
    const s = shell();
    const { container } = render(<ImportBody item={{ id: "i9", sessionId: "t1" } as CanvasItem} source={{ at: "file", host: "env_box", path: "/w/Gone.docx" }} env="env_box" state={undefined} setState={() => {}} shell={s.shell} />);
    expect(container.querySelector("[data-canvas-skeleton]")).not.toBeNull();
    // It becomes another item: no History for it meanwhile.
    expect(s.ready).toEqual([false]);
    await act(async () => fail(new Error("that file is not there any more")));
    await waitFor(() => expect(s.lines.at(-1)).toMatchObject({ tone: "failed", word: "Couldn't open this document", detail: "that file is not there any more", action: { label: "Retry" } }));
    expect(container.querySelector("[data-canvas-skeleton]")).toBeNull();
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("a file dropped on a document opens as a document; a picture is left to the editor", async () => {
    answer = async () => ({ source: SOURCE, title: "Plan", itemId: "i3", warnings: [], outsiders: false });
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
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.params).toEqual({ sessionId: "t1", from: { at: "bytes", name: "Brief.docx", data: toBase64(new Uint8Array([80, 75, 3, 4])) } });
    // A later file of the same name is another drop: it opens too, with its own bytes.
    await waitFor(() => expect(screen.queryByText("Opening Brief.docx")).toBeNull());
    await act(async () => drop(new File([new Uint8Array([80, 75, 3, 4, 9])], "Brief.docx")));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.params).toEqual({ sessionId: "t1", from: { at: "bytes", name: "Brief.docx", data: toBase64(new Uint8Array([80, 75, 3, 4, 9])) } });
  });
});
