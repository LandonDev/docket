import { useEffect, useMemo, useState } from "react";
import type { Bbox, PdfFieldValue, PdfMode, PdfSignature, PdfView } from "@shared/contract-work-pdf";
import { registry } from "../../lib/connection";
import { fromBase64, PasswordNeeded, pdfjsEngine, type PdfDoc, type PdfEngine } from "./engine";

/** The host's side of a PDF item, as its canvas uses it (src/shared/contract-work-pdf.ts). */
export interface PdfHost {
  open(): Promise<PdfView>;
  /** Bytes of the file at the view's `rev`, so one load never mixes two versions; the host refuses a version it no longer keeps. */
  read(which: "file" | "export", offset: number, length: number, rev?: string): Promise<Uint8Array>;
  review(keys: string[] | "all", verdict: "accept" | "reject"): Promise<PdfView>;
  setField(key: string, value: PdfFieldValue): Promise<PdfView>;
  mark(page: number, quads: Bbox[], text: string): Promise<PdfView>;
  unmark(markId: string): Promise<PdfView>;
  mode(mode: PdfMode): Promise<PdfView>;
  undo(writeId: string): Promise<PdfView>;
  signature(): Promise<PdfSignature | null>;
  setSignature(signature: PdfSignature | null): Promise<void>;
  sign(signed: boolean): Promise<PdfView>;
  export(flatten: boolean): Promise<{ name: string; size: number; warnings: string[] }>;
  /** The item's view as the host pushes it. */
  onView(listener: (view: PdfView) => void): () => void;
}

/** A PDF item's host through the link to the host the thread lives on. */
export function linkHost(environmentId: string, itemId: string): PdfHost {
  const link = (): ReturnType<typeof registry.linkOf> => registry.linkOf(environmentId);
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => link().request<T>(method, { itemId, ...params });
  return {
    open: () => call("work.pdf.open"),
    read: async (which, offset, length, rev) => fromBase64((await call<{ data: string }>("work.pdf.read", { which, offset, length, ...(rev ? { rev } : {}) })).data),
    review: (keys, verdict) => call("work.pdf.review", { keys, verdict }),
    setField: (key, value) => call("work.pdf.setField", { key, value }),
    mark: (page, quads, text) => call("work.pdf.mark", { page, quads, text }),
    unmark: (markId) => call("work.pdf.unmark", { markId }),
    mode: (mode) => call("work.pdf.mode", { mode }),
    undo: (writeId) => call("work.pdf.undo", { writeId }),
    signature: async () => (await link().request<{ signature: PdfSignature | null }>("work.pdf.signature", {})).signature,
    setSignature: async (signature) => void (await link().request("work.pdf.setSignature", { signature })),
    sign: (signed) => call("work.pdf.sign", { signed }),
    export: (flatten) => call("work.pdf.export", { flatten }),
    onView: (listener) =>
      link().onPush((push) => {
        if (push.push === "work.pdf" && push.view.itemId === itemId) listener(push.view);
      }),
  };
}

export type DocState =
  | { phase: "loading" }
  | { phase: "ready"; doc: PdfDoc }
  | { phase: "password"; wrong: boolean }
  | { phase: "failed"; message: string };

/** The item's view, kept current by the push, and its file opened in the engine at the view's revision. */
export function usePdfItem(
  host: PdfHost,
  engine: PdfEngine = pdfjsEngine,
): { view: PdfView | null; viewError: string | null; doc: DocState; setView(view: PdfView): void; unlock(password: string): void; retry(): void } {
  const [view, setView] = useState<PdfView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocState>({ phase: "loading" });
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    const off = host.onView((next) => live && setView(next));
    host.open().then(
      (got) => live && setView(got),
      (error: unknown) => live && setViewError(error instanceof Error ? error.message : "The host did not answer"),
    );
    return () => {
      live = false;
      off();
    };
  }, [host]);

  const rev = view?.rev;
  const size = view?.size;
  useEffect(() => {
    if (rev === undefined || size === undefined) return;
    let live = true;
    let opened: PdfDoc | null = null;
    setDoc({ phase: "loading" });
    // A version the host no longer keeps (the file changed and was opened again elsewhere): open again, which reloads at the new rev.
    const read = (offset: number, length: number): Promise<Uint8Array> =>
      host.read("file", offset, length, rev).catch((error: unknown) => {
        if (live && error instanceof Error && /changed since it was opened/.test(error.message)) void host.open().then((got) => live && setView(got), () => undefined);
        throw error;
      });
    const onFail = (message: string): void => {
      if (live) setDoc({ phase: "failed", message });
    };
    engine.open({ size, read, password, onFail }).then(
      (got) => {
        if (!live) return got.destroy();
        opened = got;
        setDoc({ phase: "ready", doc: got });
      },
      (error: unknown) => {
        if (!live) return;
        if (error instanceof PasswordNeeded) setDoc({ phase: "password", wrong: error.wrong });
        else setDoc({ phase: "failed", message: error instanceof Error && error.message ? error.message : "The file could not be read" });
      },
    );
    return () => {
      live = false;
      opened?.destroy();
    };
  }, [host, engine, rev, size, password, attempt]);

  return useMemo(() => ({ view, viewError, doc, setView, unlock: setPassword, retry: () => setAttempt((n) => n + 1) }), [view, viewError, doc]);
}
