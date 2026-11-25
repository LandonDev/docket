import { useEffect, useMemo, useRef, useState } from "react";
import type { Bbox, PdfFieldValue, PdfMode, PdfSignature, PdfView } from "@shared/contract-work-pdf";
import { registry } from "../../lib/connection";
import { onItemsGone } from "../canvas/gone";
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
  /** `rev`: the copy's own revision, which every read of it names. */
  export(flatten: boolean): Promise<{ name: string; size: number; rev?: string; warnings: string[] }>;
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

/** A file opened in the engine, at the revision and size it was read at. */
type Opened = { doc: PdfDoc; rev: string; size: number };
/** A body's file kept while its tab is not shown: its last view and its open doc. */
type KeptPdf = Opened & { view: PdfView };

/** How many files of PDF tabs not shown stay open, so a tab shown again draws at once and reads nothing again. */
export const KEPT_PDFS = 3;
/** The kept files by `${env}\n${itemId}`, the most recently left last. */
const keptPdfs = new Map<string, KeptPdf>();

function keepPdf(key: string, kept: KeptPdf): void {
  keptPdfs.get(key)?.doc.destroy();
  keptPdfs.delete(key);
  keptPdfs.set(key, kept);
  for (const [old, held] of keptPdfs) {
    if (keptPdfs.size <= KEPT_PDFS) break;
    held.doc.destroy();
    keptPdfs.delete(old);
  }
}
// A closed item's file goes with it.
onItemsGone((ids) => {
  const gone = new Set(ids);
  for (const [key, kept] of [...keptPdfs])
    if (gone.has(key.slice(key.indexOf("\n") + 1))) {
      kept.doc.destroy();
      keptPdfs.delete(key);
    }
});
/** For tests: how many files are kept, and none after. */
export const keptPdfCount = (): number => keptPdfs.size;
export function resetKeptPdfs(): void {
  for (const kept of keptPdfs.values()) kept.doc.destroy();
  keptPdfs.clear();
}

/**
 * The item's view, kept current by the push, and its file opened in the engine at the view's revision. pdf.js starts
 * loading as the body mounts, beside the ask for the view. With `keep` (the item's key), the open file outlives the body:
 * a body that comes back draws it at once and asks only the view again, and reads the file again only when the view
 * names another revision.
 */
export function usePdfItem(
  host: PdfHost,
  engine: PdfEngine = pdfjsEngine,
  keep?: string,
): { view: PdfView | null; viewError: string | null; doc: DocState; setView(view: PdfView): void; unlock(password: string): void; retry(): Promise<void> } {
  // A kept file is the body's again: taken out of the kept ones once the body is up (below).
  const [kept] = useState(() => (keep ? (keptPdfs.get(keep) ?? null) : null));
  const [view, setView] = useState<PdfView | null>(kept?.view ?? null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocState>(kept ? { phase: "ready", doc: kept.doc } : { phase: "loading" });
  /** The file open now, which the body lets go of (or keeps) as it goes. */
  const current = useRef<Opened | null>(kept);
  const shown = useRef(view);
  useEffect(() => {
    shown.current = view;
  }, [view]);
  useEffect(() => {
    engine.warm?.();
  }, [engine]);
  useEffect(() => {
    // The body's file is no longer kept while the body shows it (and again after React's checks mount it twice).
    if (keep && current.current) {
      const back = keptPdfs.get(keep);
      if (back?.doc === current.current.doc) keptPdfs.delete(keep);
    }
    return () => {
      const open = current.current;
      if (!open) return;
      if (keep && shown.current) keepPdf(keep, { ...open, view: shown.current });
      else open.doc.destroy();
    };
  }, [keep]);
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const attemptSeen = useRef(0);
  // Bumped by Retry after the view itself did not come: the host is asked again.
  const [asks, setAsks] = useState(0);
  // Retry's presses, settled once the read they asked answers: the failure stays shown until then.
  const waiters = useRef<(() => void)[]>([]);
  const settle = (): void => {
    for (const done of waiters.current.splice(0)) done();
  };

  useEffect(() => {
    let live = true;
    const off = host.onView((next) => live && setView(next));
    host.open().then(
      (got) => {
        if (!live) return;
        setViewError(null);
        setView(got);
        settle();
      },
      (error: unknown) => {
        if (!live) return;
        setViewError(error instanceof Error ? error.message : "The host did not answer");
        settle();
      },
    );
    return () => {
      live = false;
      off();
    };
  }, [host, asks]);

  const rev = view?.rev;
  const size = view?.size;
  useEffect(() => {
    if (rev === undefined || size === undefined) return;
    const open = current.current;
    // The file open already is the one this revision names (a kept one, a view pushed again): nothing is read.
    if (open && open.rev === rev && open.size === size && password === undefined && attempt === 0) return setDoc({ phase: "ready", doc: open.doc });
    let live = true;
    let opened: PdfDoc | null = null;
    current.current = null;
    open?.doc.destroy();
    // His Retry keeps the failure until the file answers; any other read shows its loading.
    const again = attempt !== attemptSeen.current;
    attemptSeen.current = attempt;
    setDoc((was) => (again && was.phase === "failed" ? was : { phase: "loading" }));
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
        current.current = { doc: got, rev, size };
        setDoc({ phase: "ready", doc: got });
        settle();
      },
      (error: unknown) => {
        if (!live) return;
        if (error instanceof PasswordNeeded) setDoc({ phase: "password", wrong: error.wrong });
        else setDoc({ phase: "failed", message: error instanceof Error && error.message ? error.message : "The file could not be read" });
        settle();
      },
    );
    return () => {
      live = false;
      // (the file open stays with the body, which lets it go or keeps it as it goes; one left behind by a new revision goes when that one opens)
      if (opened && current.current?.doc !== opened) opened.destroy();
    };
  }, [host, engine, rev, size, password, attempt]);

  // Retry asks again for what did not come: the view, else the file.
  const failedView = viewError !== null;
  return useMemo(
    () => ({
      view,
      viewError,
      doc,
      setView,
      unlock: setPassword,
      retry: () =>
        new Promise<void>((done) => {
          waiters.current.push(done);
          (failedView ? setAsks : setAttempt)((n) => n + 1);
        }),
    }),
    [view, viewError, doc, failedView],
  );
}
