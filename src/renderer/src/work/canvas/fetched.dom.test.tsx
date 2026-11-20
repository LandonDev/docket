// @vitest-environment jsdom
/**
 * A mail's attachment in the canvas pane (docs/agents/work-canvas.md "Fetched sources"): the kind waits for the host's
 * copy, a big file shows how far it got, a failed fetch says so with Retry, and Download saves the host's copy here.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem, CanvasSource, ContextChip } from "@shared/work";
import { canvasItem, drivenKinds, fakeHost } from "./testkit";
import type { CanvasShell } from "./kind";

const host = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("./testkit").fakeHost> | null,
  pushes: new Set<(push: never) => void>(),
  opens: new Set<() => void>(),
  fetch: null as null | ((itemId: string) => Promise<unknown>),
  file: new Uint8Array(),
  reads: [] as Array<{ offset: number; length: number }>,
  kept: [] as string[],
}));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: (method: string, params: Record<string, unknown> = {}) => {
      if (method === "work.canvas.fetch") return host.fetch!(params.itemId as string);
      if (method === "work.canvas.keep") return (host.kept.push(params.itemId as string), Promise.resolve({ path: "/w/Q3 report.pdf", name: "Q3 report.pdf" }));
      if (method === "work.canvas.read") {
        const offset = params.offset as number;
        const length = Math.min(params.length as number, 3);
        host.reads.push({ offset, length });
        const part = host.file.slice(offset, offset + length);
        return Promise.resolve({ data: btoa(String.fromCharCode(...part)), size: host.file.length });
      }
      return host.current!.link.request(method, params);
    },
    onPush: (listener: (push: never) => void) => (host.pushes.add(listener), () => host.pushes.delete(listener)),
    onOpen: (listener: () => void) => (host.opens.add(listener), () => host.opens.delete(listener)),
    onClose: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});
const saved = vi.hoisted(() => [] as Array<{ name: string; bytes: Uint8Array }>);
vi.mock("../../lib/native", async (original) => ({ ...(await original<typeof import("../../lib/native")>()), saveDownload: async (name: string, bytes: Uint8Array) => (saved.push({ name, bytes }), `/Downloads/${name}`) }));

import { CanvasSeat } from "./CanvasSeat";
import { resetFetches } from "./fetched";
import { canvasOf, resetCanvasStore } from "./store";

const ATTACHMENT: CanvasSource = { at: "mail", threadId: "mt1", messageId: "mm1", partId: "2", name: "Q3 report.pdf", contentType: "application/pdf", size: 5_000_000 };
const ITEM = canvasItem("att", { title: "Q3 report.pdf", source: ATTACHMENT });

const deferred = () => {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const push = (p: unknown): void => {
  for (const fn of host.pushes) (fn as (x: unknown) => void)(p);
};

beforeEach(() => {
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
  HTMLElement.prototype.releasePointerCapture ??= () => undefined;
  localStorage.clear();
  resetCanvasStore();
  resetFetches();
  saved.length = 0;
  host.reads.length = 0;
  host.kept.length = 0;
});
afterEach(cleanup);

async function seat(items: CanvasItem[], o: { onAsk?: (chip: ContextChip) => void; shells?: CanvasShell[] } = {}) {
  host.current = fakeHost(items, host as never);
  const kinds = drivenKinds((shell) => o.shells?.push(shell), { bar: true });
  const view = render(
    <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds} onAsk={o.onAsk}>
      <div data-testid="thread" />
    </CanvasSeat>,
  );
  await waitFor(() => expect(canvasOf("t1").loaded).toBe(true));
  await act(async () => {});
  return view;
}

describe("an attachment in the pane", () => {
  it("waits for the host's copy, shows how far a big one got, then opens the kind with Download in its bar", async () => {
    const fetch = deferred();
    const asked: string[] = [];
    host.fetch = (id) => (asked.push(id), fetch.promise);
    const { container } = await seat([ITEM]);
    expect(asked).toEqual(["att"]);
    expect(container.querySelector("[data-fetching]")).not.toBeNull();
    expect(screen.queryByTestId("body")).toBeNull();
    // The kind's own tools wait with it: the bar holds its bone.
    expect(screen.queryByTestId("kind-tools")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    act(() => push({ push: "work.canvas.fetch", sessionId: "t1", itemId: "att", received: 2 * 1024 * 1024, total: 5 * 1024 * 1024 }));
    expect(screen.getByRole("progressbar", { name: "Getting Q3 report.pdf" })).toBeTruthy();
    expect(screen.getByText("2.0 of 5.0 MB")).toBeTruthy();
    await act(async () => fetch.resolve({ size: 5 }));
    expect(screen.getByTestId("body").textContent).toBe("The body of Q3 report.pdf");
    expect(screen.getByTestId("kind-tools")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    // A late push never takes the landed file back.
    act(() => push({ push: "work.canvas.fetch", sessionId: "t1", itemId: "att", received: 1, total: 5 }));
    expect(screen.getByTestId("body")).toBeTruthy();
  });

  it("shows no bar for a small file, only the bones", async () => {
    host.fetch = () => new Promise(() => {});
    await seat([ITEM]);
    act(() => push({ push: "work.canvas.fetch", sessionId: "t1", itemId: "att", received: 10, total: 4000 }));
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("says a failed fetch with Retry, never bones, and Retry asks again", async () => {
    let n = 0;
    host.fetch = () => (++n === 1 ? Promise.reject(new Error("LifeOS could not get this file from the mail.")) : Promise.resolve({ size: 5 }));
    const { container } = await seat([canvasItem("att", { kind: "pdf", title: "Q3 report.pdf", source: ATTACHMENT })]);
    await act(async () => {});
    expect(screen.getByText("Couldn't open this PDF")).toBeTruthy();
    expect(screen.getByText("LifeOS could not get this file from the mail.")).toBeTruthy();
    expect(container.querySelector("[data-fetching]")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(n).toBe(2);
    expect(screen.queryByText("Couldn't open this PDF")).toBeNull();
  });

  it("Download reads the host's copy by range and saves it under the attachment's own name", async () => {
    host.fetch = () => Promise.resolve({ size: 7 });
    host.file = new TextEncoder().encode("%PDF-1.");
    await seat([ITEM]);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Download" })));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.name).toBe("Q3 report.pdf");
    expect(new TextDecoder().decode(saved[0]!.bytes)).toBe("%PDF-1.");
    expect(host.reads.map((r) => r.offset)).toEqual([0, 3, 6]);
  });

  it("Save to workspace asks the host for a copy in the workspace's folder; a pane with no workspace has none", async () => {
    host.fetch = () => Promise.resolve({ size: 7 });
    await seat([ITEM, canvasItem("chat", { title: "From a Work Chat.pdf", source: { ...ATTACHMENT, partId: "3" }, workspaceId: null })]);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save to workspace" })));
    expect(host.kept).toEqual(["att"]);
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: /From a Work Chat/ })));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save to workspace" })).toBeNull();
  });

  it("a file read where it is opens at once, with no Download", async () => {
    host.fetch = () => Promise.reject(new Error("asked"));
    await seat([canvasItem("doc", { title: "Run of show" })]);
    expect(screen.getByTestId("body")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });
});

describe("a pane with no thread (the Mail view's)", () => {
  it("sends Ask where the view says, and offers no Open from Google", async () => {
    host.fetch = () => Promise.resolve({ size: 5 });
    const asked: ContextChip[] = [];
    const shells: CanvasShell[] = [];
    await seat([ITEM], { onAsk: (chip) => asked.push(chip), shells });
    await act(async () => {});
    const chip: ContextChip = { kind: "item", label: "Q3 report.pdf", ref: ATTACHMENT };
    act(() => shells.at(-1)!.ask!(chip));
    expect(asked).toEqual([chip]);
    const { contextChipsOf } = await import("./chips");
    expect(contextChipsOf("t1")).toEqual([]);
  });
});

describe("a mail's file is read only until it is kept", () => {
  it("a mail's PDF and a mail's sheet draw no mode menu, stepper or written line, whatever the kind feeds; a kept one does", async () => {
    host.fetch = () => Promise.resolve({ size: 5 });
    const noop = async (): Promise<void> => undefined;
    // Fed once per item, as a kind's effect would: a new adapter on every render would never settle.
    const fed = new WeakSet<CanvasShell>();
    const driven = drivenKinds((shell) => {
      if (fed.has(shell)) return;
      fed.add(shell);
      shell.mode({ value: "suggests", set: () => undefined });
      shell.review({ groups: [{ id: "g", label: "Agent", by: "agent:box:t", count: 2 }], index: 0, count: 2, step: () => undefined, accept: noop, reject: noop });
    });
    const kinds = { ...driven, pdf: { ...driven.pdf, chunk: driven.document.chunk, history: true }, sheet: { ...driven.sheet, chunk: driven.document.chunk, history: true } };
    const mailPdf = canvasItem("mp", { kind: "pdf", title: "Contract.pdf", source: ATTACHMENT });
    const mailSheet = canvasItem("ms", { kind: "sheet", title: "Budget.xlsx", source: { ...ATTACHMENT, partId: "3", name: "Budget.xlsx" } });
    const kept = canvasItem("kp", { kind: "pdf", title: "Contract (kept).pdf", source: { at: "file", host: "local", path: "/Cosmic/Contract.pdf" } });
    host.current = fakeHost([mailPdf, mailSheet, kept], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds}>
        <div data-testid="thread" />
      </CanvasSeat>,
    );
    await waitFor(() => expect(canvasOf("t1").loaded).toBe(true));
    const bar = () => document.querySelector("[data-canvas-bar]")?.textContent ?? "";
    for (const name of [/Contract\.pdf/, /Budget\.xlsx/]) {
      await act(async () => fireEvent.click(screen.getByRole("tab", { name })));
      await act(async () => {});
      expect(screen.getByTestId("body")).toBeTruthy();
      expect(bar()).not.toMatch(/Suggests|Reject|Accept|History/);
      expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save to workspace" })).toBeTruthy();
    }
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: /Contract \(kept\)/ })));
    await act(async () => {});
    expect(bar()).toMatch(/Suggests/);
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });
});
