import { forwardRef, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ChoiceToggle } from "../../components/choice-toggle";
import { BusyLabel, Button } from "../../components/ui/button";
import { Kbd } from "../../components/ui/kbd";
import { X } from "../../chrome/icons";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { ErrorLine } from "../../chrome/ConfirmDialog";
import { keyHint } from "../../lib/keys";
import { connectingWords, lifeosDownWords } from "../shell/lifeosWords";
import type { LifeosStateName } from "@shared/contract-work-lifeos";
import type { SectorKey } from "@shared/work";
import { choiceLabel, SECTOR_CHOICES, type DraftFile, type SectorChoice } from "./draft";

/**
 * The capture window's page as data (docs/DESIGN.md "The capture window"):
 * the field, the files he added, a line when something is wrong, and one
 * row under a hairline with the job and the two ways to file. The
 * window is the surface: no card inside it. Stateless, for ui:preview and
 * the tests; page.tsx holds the draft.
 */
export interface CaptureViewProps {
  text: string;
  files: readonly DraftFile[];
  sector: SectorChoice;
  /** his jobs by their workspaces' names (`CaptureState.jobs`); the sector's word where none names one */
  jobs?: readonly { sector: SectorKey; name: string }[];
  /** offline: LifeOS cannot take a capture here now (`lifeos` says why); silent: this computer's host did not answer the window's ask */
  status: "ready" | "offline" | "silent";
  /** the host's LifeOS state while offline; none from a host a build behind */
  lifeos?: LifeosStateName;
  /** this computer's name ("This Mac"), named in every state */
  host?: string;
  /** asks the host again (the page's refresh) */
  onRetry?(): void;
  /** that ask is out: Retry spins, held, the line and the draft as they were, until its answer replaces them */
  retrying?: boolean;
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

/**
 * Why nothing can be filed, in the rule's words with this computer named (docs/DESIGN.md "The capture window"); `retry`
 * where it is silence, which asking again can mend. A host a build behind names no state: its old words stand.
 */
export function captureDown(p: Pick<CaptureViewProps, "status" | "lifeos" | "host">): { words: string; retry: boolean } | null {
  const host = p.host ?? "This computer";
  if (p.status === "silent") return { words: lifeosDownWords("unanswered", false, host), retry: true };
  if (p.status !== "offline") return null;
  if (!p.lifeos) return { words: "Not signed in to LifeOS", retry: false };
  if (p.lifeos === "connecting" || p.lifeos === "connected") return { words: connectingWords(host), retry: false };
  return { words: lifeosDownWords(p.lifeos, false, host), retry: p.lifeos === "unreachable" };
}

/**
 * The field's height in whole 22px lines: 14px over the first line and 8px under the last, so the empty field is one
 * line (44px) and each line he types adds 22px, up to twelve (286px), then it scrolls. The window follows the page.
 */
export const FIELD_LINES = "min-h-11 max-h-[17.875rem]";

export const CaptureView = forwardRef<HTMLTextAreaElement, CaptureViewProps>(function CaptureView(p, field) {
  // Held while nothing can be filed: LifeOS away, or this computer's host silent (Retry stands beside them).
  const off = p.status !== "ready" || !p.canFile;
  const down = captureDown(p);
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
        rows={1}
        value={p.text}
        onChange={(e) => p.onText(e.target.value)}
        onKeyDown={p.onKeyDown}
        onPaste={p.onPaste}
        className={`field-sizing-content ${FIELD_LINES} w-full resize-none overflow-x-hidden overflow-y-auto bg-transparent px-4 pt-3.5 pb-2 text-sm leading-[22px] text-foreground outline-none placeholder:text-faint-foreground`}
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
      ) : down?.retry ? (
        // Silence, this computer's host's or LifeOS's: red, the computer named, Retry asks again; the draft stays.
        <div role="alert" className="flex min-h-6 items-center gap-2 px-4 pb-2">
          <ErrorLine error={down.words} />
          {p.onRetry ? (
            <Button variant="ghost" size="xs" disabled={p.retrying} onClick={p.onRetry}>
              <BusyLabel busy={!!p.retrying} label="Retry" />
            </Button>
          ) : null}
        </div>
      ) : down ? (
        // A state, not a fault: muted, and no press here (ruling 29); the fix is on Connections.
        <p className="px-4 pb-2 text-xs text-muted-foreground">{down.words}</p>
      ) : null}
      <div className="flex h-12 items-center gap-2 border-t border-border px-4">
        <ChoiceToggle label="Job" fit value={p.sector} options={SECTOR_CHOICES.map((value) => ({ value, label: choiceLabel(value, p.jobs) }))} onChange={p.onSector} />
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
