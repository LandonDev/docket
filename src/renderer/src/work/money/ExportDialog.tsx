import { useState } from "react";
import type { MoneyExport } from "@shared/contract-work-money";
import type { CanvasSource } from "@shared/work/canvas";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { CheckRow, Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { loadToast } from "../../components/ui/toaster";
import { openWorkView } from "../../lib/workSwitch";
import { request } from "./api";
import { keepPrinted, printPage } from "./print";

/**
 * Export… (docs/DESIGN.md "The Money view"): a year's books for tax time in
 * the job's Money/Tax <year>/ folder. The host writes the spreadsheet and
 * the CSV; the window prints the summary and hands its bytes back to be kept.
 */

export interface ExportChoice {
  year: number;
  xlsx: boolean;
  csv: boolean;
  pdf: boolean;
}

/** What Export does: the host's files, then the summary printed and kept. Answers the folder and every line that could not be made. */
export async function runExport(env: string, workspaceId: string, choice: ExportChoice): Promise<{ folder: CanvasSource; files: string[]; warnings: string[] }> {
  const made = await request<MoneyExport>(env, "work.money.export", { workspaceId, ...choice });
  const warnings = [...made.warnings];
  if (made.summary) {
    try {
      const printed = await printPage(env, made.summary.name, made.summary.html);
      warnings.push(...printed.warnings);
      await keepPrinted(env, { workspaceId, what: "summary", year: choice.year }, printed.data);
    } catch (err) {
      warnings.push(`The summary was not made: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { folder: made.folder, files: made.files, warnings };
}

/** Show in Files: the folder as a page tab of Files, then Files. */
export async function showFolder(env: string, workspaceId: string, folder: CanvasSource, name: string): Promise<void> {
  if (folder.at === "file") await request(env, "work.files.tabOpen", { workspaceId, page: { at: folder, name } }).catch(() => undefined);
  openWorkView({ workspaceId, view: "files" });
}

export function ExportDialog({ env, workspaceId, year, onClose }: { env: string; workspaceId: string; year: number; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title="Export" size="sm" busy={pending}>
      <Body env={env} workspaceId={workspaceId} year={year} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ env, workspaceId, year, onClose, pending, setPending }: { env: string; workspaceId: string; year: number; onClose: () => void; pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const this_ = new Date().getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => String(this_ - i));
  const [choice, setChoice] = useState<ExportChoice>({ year: Math.min(year, this_), xlsx: true, csv: true, pdf: true });
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<ExportChoice>) => setChoice((c) => ({ ...c, ...p }));
  const any = choice.xlsx || choice.csv || choice.pdf;

  const submit = () => {
    if (!any || pending) return;
    setError(null);
    setPending(true);
    runExport(env, workspaceId, choice).then(
      ({ folder, warnings }) => {
        setPending(false);
        const name = `Tax ${choice.year}`;
        void loadToast().then((toast) =>
          toast(`Exported ${choice.year} for tax time`, {
            ...(warnings.length ? { description: warnings.join("\n") } : {}),
            action: { label: "Show in Files", onClick: () => void showFolder(env, workspaceId, folder, name) },
          }),
        );
        close ? close(onClose) : onClose();
      },
      (err: Error) => {
        setPending(false);
        setError(err.message);
      },
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ModalBody>
        <Field label="Year">
          <ChoiceSelect label="Year" className="w-full" value={String(choice.year)} options={years.map((y) => ({ value: y, label: y }))} onChange={(y) => patch({ year: Number(y) })} />
        </Field>
        <div className="flex flex-col">
          <CheckRow label="Spreadsheet (Excel)" checked={choice.xlsx} onCheckedChange={(xlsx) => patch({ xlsx })} />
          <CheckRow label="CSV" checked={choice.csv} onCheckedChange={(csv) => patch({ csv })} />
          <CheckRow label="Summary (PDF)" checked={choice.pdf} onCheckedChange={(pdf) => patch({ pdf })} />
        </div>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Export" pending={pending} disabled={!any} />
    </form>
  );
}
