import { forwardRef, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ChoiceToggle } from "../../components/choice-toggle";
import { Button } from "../../components/ui/button";
import { Kbd } from "../../components/ui/kbd";
import { X } from "../../chrome/icons";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { ErrorLine } from "../../chrome/ConfirmDialog";
import { keyHint } from "../../lib/keys";
import { choiceLabel, SECTOR_CHOICES, type DraftFile, type SectorChoice } from "./draft";

/**
 * The capture window's page as data (docs/DESIGN.md "The capture window"):
 * the field, the files he added, a line when something is wrong, and one
 * row under a hairline with the sector and the two ways to file. The
 * window is the surface: no card inside it. Stateless, for ui:preview and
 * the tests; page.tsx holds the draft.
 */
export interface CaptureViewProps {
  text: string;
  files: readonly DraftFile[];
  sector: SectorChoice;
  /** offline: LifeOS does not answer here */
  status: "ready" | "offline";
  /** what stops this draft, or what the last try answered */
  error: string | null;
  /** a file is being dragged over the window */
  dragging?: boolean;
  /** the draft can be filed as it is */
  canFile: boolean;
  onText(text: string): void;
  onSector(sector: SectorChoice): void;
  onRemoveFile(id: string): void;
  onFile(start: boolean): void;
  onKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onPaste?(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onDragOver?(event: DragEvent<HTMLDivElement>): void;
  onDragLeave?(event: DragEvent<HTMLDivElement>): void;
  onDrop?(event: DragEvent<HTMLDivElement>): void;
}

const OPTIONS = SECTOR_CHOICES.map((value) => ({ value, label: choiceLabel(value) }));

export const CaptureView = forwardRef<HTMLTextAreaElement, CaptureViewProps>(function CaptureView(p, field) {
  const off = p.status === "offline" || !p.canFile;
  return (
    <div
      data-capture
      className="relative flex flex-col bg-popover text-popover-foreground"
      onDragOver={p.onDragOver}
      onDragLeave={p.onDragLeave}
      onDrop={p.onDrop}
    >
      <textarea
        ref={field}
        aria-label="Capture"
        placeholder="Capture…"
        rows={2}
        value={p.text}
        onChange={(e) => p.onText(e.target.value)}
        onKeyDown={p.onKeyDown}
        onPaste={p.onPaste}
        className="field-sizing-content max-h-66 min-h-[3.75rem] w-full resize-none overflow-x-hidden overflow-y-auto bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-[22px] text-foreground outline-none placeholder:text-faint-foreground"
      />
      {p.files.length ? (
        <ul aria-label="Files" className="flex flex-col px-2 pb-2">
          {p.files.map((f) => (
            <li key={f.id} className="flex h-7 items-center gap-2 rounded-md ps-2 pe-0.5">
              <FileTypeIcon name={f.name} isDir={false} size={16} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{f.name}</span>
              <Button variant="ghost" size="icon-xs" aria-label={`Remove ${f.name}`} onClick={() => p.onRemoveFile(f.id)}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {p.error ? (
        <div role="alert" className="px-4 pb-2">
          <ErrorLine error={p.error} />
        </div>
      ) : p.status === "offline" ? (
        <p className="px-4 pb-2 text-xs text-muted-foreground">LifeOS is not connected</p>
      ) : null}
      <div className="flex h-12 items-center gap-2 border-t border-border px-3">
        <ChoiceToggle label="Sector" value={p.sector} options={OPTIONS} onChange={p.onSector} />
        <span className="flex-1" />
        <Button variant="secondary" size="sm" disabled={off} onClick={() => p.onFile(true)}>
          Start thread
          <Kbd size="sm" aria-hidden="true" className="border-transparent bg-transparent text-muted-foreground">
            {keyHint("mod+return")}
          </Kbd>
        </Button>
        <Button size="sm" disabled={off} onClick={() => p.onFile(false)}>
          File
        </Button>
      </div>
      {p.dragging ? (
        <div
          data-file-wash
          className="pointer-events-none absolute inset-3 grid place-items-center rounded-lg border border-border bg-muted/70 transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0 motion-reduce:transition-none"
        >
          <span className="text-[13px] text-muted-foreground">Drop to add</span>
        </div>
      ) : null}
    </div>
  );
});
