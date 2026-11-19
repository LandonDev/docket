import { useState } from "react";
import type { ExportAnswer, ExportFormat } from "@shared/contract-work-formats";
import type { CanvasSource } from "@shared/work";
import type { AnyEditor } from "work-kit/editor";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { FieldRow } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { servedBy } from "../docs/host";
import { fileStem, FORMAT_CHOICES, formatNote, fromBase64, madeOnHost, mimeOf, paperFor, toBase64, warningsLine } from "./model";

/**
 * The document's Export (docs/DESIGN.md "The canvas pane": Export is a
 * dialog with one choice): the format, then Export. Word, OpenDocument, RTF
 * and markdown are written on the host from the live text (comments and
 * pending suggestions go with Word); a web page is the editor's own blocks
 * written here; a PDF is that page laid out for paper and printed on the
 * host. The file is saved where downloads go. The last format chosen is the
 * next one offered.
 */

const LAST = "work.formats.export.format";

export interface ExportTarget {
  env: string;
  source: CanvasSource;
  title: string;
  editor: AnyEditor | null;
  suggestions: number;
}

export function ExportDialog({ target, onClose }: { target: ExportTarget; onClose(): void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title="Export" busy={pending}>
      <Body target={target} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function lastFormat(): ExportFormat {
  const kept = typeof localStorage === "undefined" ? null : localStorage.getItem(LAST);
  return FORMAT_CHOICES.some((c) => c.value === kept) ? (kept as ExportFormat) : "docx";
}

function Body({ target, onClose, pending, setPending }: { target: ExportTarget; onClose(): void; pending: boolean; setPending(p: boolean): void }) {
  const close = useModalClose();
  const [format, setFormat] = useState<ExportFormat>(lastFormat);
  const [error, setError] = useState<string | null>(null);
  const comments = target.editor?.domElement?.querySelectorAll(".bn-thread-mark").length ?? 0;
  const note = formatNote(format, { comments, suggestions: target.suggestions });

  const run = async (): Promise<void> => {
    setError(null);
    setPending(true);
    try {
      const made = await make(target, format);
      localStorage.setItem(LAST, format);
      setPending(false);
      const save = () => {
        saveFile(made.name, new Blob([fromBase64(made.data)], { type: mimeOf(format) }));
        const line = warningsLine(made.warnings);
        if (line) void loadToast().then((toast) => toast(line));
      };
      if (close) close(save);
      else save();
    } catch (err) {
      setPending(false);
      setError(err instanceof Error && err.message ? err.message : "It could not be exported");
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <ModalBody>
        <FieldRow label="Format" description={note ?? undefined}>
          <ChoiceSelect label="Format" value={format} options={FORMAT_CHOICES} onChange={setFormat} />
        </FieldRow>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Export" busyLabel="Exporting…" pending={pending} disabled={!madeOnHost(format) && !target.editor} />
    </form>
  );
}

/** The file, made where its format is made; a LifeOS document another host serves is asked of that host. */
async function make(target: ExportTarget, format: ExportFormat): Promise<ExportAnswer> {
  const stem = fileStem(target.title);
  const ask = async (env: string): Promise<ExportAnswer> => {
    if (madeOnHost(format)) return registry.linkOf(env).request<ExportAnswer>("work.formats.export", { source: target.source, format }, { timeoutMs: 5 * 60_000 });
    const editor = target.editor;
    if (!editor) throw new Error("The document is still opening");
    const { htmlDocument } = await import("work-kit/formats/html");
    if (format === "html") {
      const page = await htmlDocument(editor, editor.document as never, { title: target.title });
      return { name: `${stem}.html`, data: toBase64(new TextEncoder().encode(page)), warnings: [] };
    }
    const paper = paperFor(navigator.language);
    const page = await htmlDocument(editor, editor.document as never, { title: target.title, print: { paper } });
    return registry.linkOf(env).request<ExportAnswer>("work.formats.print", { name: stem, html: page, paper }, { timeoutMs: 2 * 60_000 });
  };
  try {
    return await ask(target.env);
  } catch (err) {
    const other = servedBy(err);
    if (other && other !== target.env) return ask(other);
    throw err;
  }
}

/** Saves a file where the person keeps downloads. */
function saveFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
