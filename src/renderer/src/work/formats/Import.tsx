import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ImportAnswer } from "@shared/contract-work-formats";
import type { AnyEditor } from "work-kit/editor";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
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

/** One import per item at a time: an effect run twice (React's dev check, a quick remount) makes one document. */
const inFlight = new Map<string, Promise<ImportAnswer>>();

function importOnce(env: string, key: string, params: Record<string, unknown>): Promise<ImportAnswer> {
  const running = inFlight.get(key);
  if (running) return running;
  const p = registry
    .linkOf(env)
    .request<ImportAnswer>("work.formats.import", params, { timeoutMs: IMPORT_MS })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

const sayWarnings = (a: ImportAnswer): void => {
  const line = warningsLine(a.warnings);
  if (line) void loadToast().then((toast) => toast(line));
};

/** The body of a Word file's item while it becomes a document: the editor's bones, or the one state line when it cannot. */
export function ImportBody({ item, source, env, shell }: CanvasBodyProps<unknown>) {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    shell.statusLine(null);
    importOnce(env, `${item.id}#${attempt}`, { sessionId: item.sessionId, itemId: item.id, from: { at: "source", source } }).then(sayWarnings, (err: unknown) => {
      if (!live) return;
      shell.statusLine({
        tone: "failed",
        word: "Did not open",
        detail: err instanceof Error && err.message ? err.message : "It could not be read",
        action: { label: "Retry", run: () => setAttempt((n) => n + 1) },
      });
    });
    return () => {
      live = false;
    };
  }, [env, item.id, item.sessionId, source, shell, attempt]);
  return (
    <div aria-busy className="flex flex-col gap-2.5 px-6 pt-8" style={{ paddingLeft: 76, maxWidth: 52 + 672 + 24 }}>
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="mt-4 h-3 w-[92%]" />
      <Skeleton className="h-3 w-[78%]" />
      <Skeleton className="h-3 w-[44%]" />
    </div>
  );
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
    if (!importable(file.name)) return void toast.error("A document opens from Word, OpenDocument, RTF, markdown, HTML or PDF");
    if (file.size > DROP_MAX_BYTES) return void toast.error("That file is over 64 MB");
    setBusy(file.name);
    try {
      sayWarnings(await importOnce(env, `drop#${sessionId}#${file.name}`, { sessionId, from: await fromFile(file, editor) }));
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
        e.preventDefault();
        leave();
        const file = e.dataTransfer.files[0];
        if (file && !busy) void drop(file);
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
