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
import { STALE_SUMMARY } from "@shared/work/money";
import { noHeldReturn } from "./fields";
import { keepPrinted, newKey, printPage } from "./print";

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

/** What Export made: the folder, every file that landed (the kept summary among them), and in words what did not. */
export interface ExportMade {
  folder: CanvasSource;
  files: string[];
  warnings: string[];
  replaced: boolean;
}


/**
 * What Export does: the host's files, then the summary printed and kept with this export's `generation`, under a key of this
 * export's own: a retry that read fresh rows is a new export, and never answers an older kept summary. Refuses when nothing landed.
 */
export async function runExport(env: string, workspaceId: string, choice: ExportChoice): Promise<ExportMade> {
  const made = await request<MoneyExport>(env, "work.money.export", { workspaceId, ...choice });
  const key = newKey();
  const warnings = [...made.warnings];
  const files = [...made.files];
  // Replaced: a file this export wrote, or the summary it kept, took an earlier one's place.
  let replaced = made.replaced;
  if (made.summary) {
    try {
      const printed = await printPage(env, made.summary.name, made.summary.html);
      warnings.push(...printed.warnings);
      const kept = await keepPrinted(env, { workspaceId, what: "summary", year: choice.year, generation: made.generation }, printed.data, key);
      if (kept.replaced) replaced = true;
      files.push(kept.receipt?.split(/[\\/]/).pop() ?? `${made.summary.name}.pdf`);
    } catch (err) {
      const words = err instanceof Error ? err.message : String(err);
      // The host's own sentence for a summary not of the year's newest export, said as it is, with no "not made" before it.
      warnings.push(STALE_SUMMARY.test(words) ? words : `The summary was not made: ${words}`);
    }
  }
  if (!files.length) throw new Error(warnings.join(", ") || "Nothing was made");
  return { folder: made.folder, files, warnings, replaced };
}

/** The toast's second line: that an earlier export was replaced, and what could not be made, as one comma run. */
export const exportNote = (made: Pick<ExportMade, "warnings" | "replaced">): string | null => {
  const parts = [...(made.replaced ? ["Replaced the earlier export."] : []), ...made.warnings].map((p) => p.trim().replace(/\.$/, "")).filter(Boolean);
  if (!parts.length) return null;
  // One sentence: later parts start in lower case unless they start with a name in capitals ("CSV", "PDF").
  const run = parts.map((p, i) => (i > 0 && /^[A-Z][a-z]/.test(p) ? p[0].toLowerCase() + p.slice(1) : p)).join(", ");
  return `${run}.`;
};

/** The years offered, this one and the four before, and the one chosen first: the period's when offered, else the oldest offered. */
export function exportYears(periodYear: number, now: number = new Date().getFullYear()): { years: number[]; first: number } {
  const years = Array.from({ length: 5 }, (_, i) => now - i);
  return { years, first: years.includes(periodYear) ? periodYear : years[years.length - 1] };
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
  const { years, first } = exportYears(year);
  const [choice, setChoice] = useState<ExportChoice>({ year: first, xlsx: true, csv: true, pdf: true });
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<ExportChoice>) => setChoice((c) => ({ ...c, ...p }));
  const any = choice.xlsx || choice.csv || choice.pdf;

  const submit = () => {
    if (!any || pending || !years.includes(choice.year)) return;
    setError(null);
    setPending(true);
    runExport(env, workspaceId, choice).then(
      (made) => {
        setPending(false);
        const name = `Tax ${choice.year}`;
        const note = exportNote(made);
        void loadToast().then((toast) =>
          toast(`Exported ${choice.year} for tax time`, {
            ...(note ? { description: note } : {}),
            action: { label: "Show in Files", onClick: () => void showFolder(env, workspaceId, made.folder, name) },
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
      onKeyDown={noHeldReturn}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ModalBody>
        <Field label="Year">
          <ChoiceSelect label="Year" className="w-full" value={String(choice.year)} options={years.map((y) => ({ value: String(y), label: String(y) }))} onChange={(y) => patch({ year: Number(y) })} />
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
