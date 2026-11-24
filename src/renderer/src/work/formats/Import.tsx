import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ImportAnswer } from "@shared/contract-work-formats";
import type { AnyEditor } from "work-kit/editor";
import { Spinner } from "../../components/ui/spinner";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { ItemSkeleton } from "../canvas/ItemBones";
import type { CanvasBodyProps } from "../canvas/kind";
import { DROP_MAX_BYTES, importable, isHtml, toBase64, warningsLine } from "./model";

/**
 * Import (docs/agents/work-formats.md "Import and export"): a Word,
 * OpenDocument or RTF file opened in the canvas becomes a `.tcdoc` beside it
 * and the item reopens on that (the host closes this one); a file dropped on
 * a document opens as a new document in the same canvas. HTML is read here,
 * where there is a DOM, and goes to the host as blocks.
 */

const IMPORT_MS = 5 * 60_000;

/**
 * One import per key: an effect run again (React's dev check, a remount, a new shell before the host's
 * push closes the item) gets the same answer and makes no second document. A key that failed is
 * forgotten, so Retry asks again.
 */
const imports = new Map<string, Promise<ImportAnswer>>();

function importOnce(env: string, key: string, params: Record<string, unknown>): Promise<ImportAnswer> {
  const known = imports.get(key);
  if (known) return known;
  const p = registry.linkOf(env).request<ImportAnswer>("work.formats.import", params, { timeoutMs: IMPORT_MS });
  p.catch(() => imports.delete(key));
  imports.set(key, p);
  return p;
}

/**
 * A mail's attachment read as a document, once per item: the host makes `<name>.tcdoc` beside its fetched copy and
 * answers it, read only (work-mail.md "Attachments"). The item stays the attachment.
 */
export const readAttachment = (env: string, item: { id: string; source: unknown }): Promise<ImportAnswer> => importOnce(env, `${item.id}#attachment`, { itemId: item.id, from: { at: "source", source: item.source } });

/**
 * Keep as document: the attachment is saved into the workspace's folder (`work.canvas.keep`) and imported from there
 * as a document of his own, which opens in the pane in the attachment's place.
 */
export async function keepAsDocument(env: string, item: { id: string; sessionId: string }): Promise<void> {
  const link = registry.linkOf(env);
  const kept = await link.request<{ path: string }>("work.canvas.keep", { itemId: item.id });
  const answer = await link.request<ImportAnswer>("work.formats.import", { sessionId: item.sessionId, itemId: item.id, from: { at: "source", source: { at: "file", host: env, path: kept.path } } }, { timeoutMs: IMPORT_MS });
  sayWarnings(answer);
}

const sayWarnings = (a: ImportAnswer): void => {
  const line = warningsLine(a.warnings);
  if (line) void loadToast().then((toast) => toast(line));
};

/** The body of a Word file's item while it becomes a document: the editor's bones, or, when it cannot, the one state line over nothing. */
export function ImportBody({ item, source, env, shell }: CanvasBodyProps<unknown>) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const said = useRef(false);
  // The item is replaced by the document it becomes; until then it has no versions to show.
  useLayoutEffect(() => shell.ready?.(false), [shell]);
  useEffect(() => {
    let live = true;
    setFailed(false);
    shell.statusLine(null);
    importOnce(env, `${item.id}#${attempt}`, { sessionId: item.sessionId, itemId: item.id, from: { at: "source", source } }).then(
      (a) => {
        if (said.current) return;
        said.current = true;
        sayWarnings(a);
      },
      (err: unknown) => {
      if (!live) return;
      setFailed(true);
      shell.statusLine({
        tone: "failed",
        word: "Couldn't open this document",
        detail: err instanceof Error && err.message ? err.message : "It could not be read",
        action: { label: "Retry", run: () => setAttempt((n) => n + 1) },
      });
      },
    );
    return () => {
      live = false;
    };
  }, [env, item.id, item.sessionId, source, shell, attempt]);
  return failed ? null : <ItemSkeleton />;
}

/** A dropped file as the import's `from`: HTML read into blocks here, anything else its bytes. */
async function fromFile(file: File, editor: AnyEditor | null): Promise<Record<string, unknown>> {
  if (isHtml(file.name)) {
    const { readHtml } = await import("work-kit/formats/html");
    const reader = editor ?? (await import("work-kit/editor")).createHeadlessEditor();
    return { at: "blocks", name: file.name, blocks: readHtml(reader, await file.text()) };
  }
  return { at: "bytes", name: file.name, data: toBase64(new Uint8Array(await file.arrayBuffer())) };
}

const hasFiles = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes("Files");

/**
 * A document's surface takes a file dropped on it: the file is kept in the
 * thread's workspace folder and opens beside as a document of its own.
 * While a file is over it, a quiet wash says what a drop does.
 */
export function DropImport({ env, sessionId, editor, children }: { env: string; sessionId: string; editor: AnyEditor | null; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const depth = useRef(0);
  const leave = () => {
    depth.current = 0;
    setOver(false);
  };
  const drop = async (file: File): Promise<void> => {
    const toast = await loadToast();
    if (file.size > DROP_MAX_BYTES) return void toast.error("That file is over 64 MB");
    setBusy(file.name);
    try {
      // A drop is his press: each one imports, however its file is named (a busy surface takes none meanwhile).
      sayWarnings(await registry.linkOf(env).request<ImportAnswer>("work.formats.import", { sessionId, from: await fromFile(file, editor) }, { timeoutMs: IMPORT_MS }));
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "It could not be opened");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div
      data-drop-import
      className="relative h-full"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        if (--depth.current <= 0) leave();
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        leave();
        // A file that is not a document (a picture) is the editor's to take.
        const file = Array.from(e.dataTransfer.files).find((f) => importable(f.name));
        if (!file) return;
        e.preventDefault();
        if (!busy) void drop(file);
      }}
    >
      {children}
      {over || busy ? (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-3 grid place-items-center rounded-lg border border-border bg-muted/70 transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0"
        >
          <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {busy ? <Spinner className="size-3.5" /> : null}
            {busy ? `Opening ${busy}` : "Drop to open as a document"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
