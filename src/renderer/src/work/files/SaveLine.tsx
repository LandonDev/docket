import type { ReactNode } from "react";
import type { MenuRow } from "../../chrome/menuRows";
import { TruncateTip } from "../../components/tip";
import { BusyLabel, Button } from "../../components/ui/button";
import type { SavedAction } from "../canvas/kind";
import { savedNeedsHim, savedWords, type HeaderLine } from "./fileText";

/**
 * The one line under a file's name that says what saved means now (docs/DESIGN.md "The Files place"). There is no
 * save press anywhere: the line is small and muted while all is well, and takes the foreground only when it needs
 * him (the file changed somewhere else, changes wait here). The folder in "Saved 1:52 PM in Events" is a press
 * that shows it.
 */
export function SaveLine({ line, where, onShowFolder }: { line: HeaderLine; where: string | null; onShowFolder?(): void }) {
  // A copy's line is the frame's own words (fileText.ts `copyLine`): it names the computer, and no folder of this one.
  const words = line.words ?? savedWords(line, where);
  const place = line.state === "saved" && line.words === undefined ? (line.where ?? where) : null;
  const needs = !!line.needs || savedNeedsHim(line);
  let text: ReactNode = words;
  if (place && onShowFolder && words.endsWith(place)) {
    text = (
      <>
        {words.slice(0, -place.length)}
        <Button variant="link" className="h-auto min-w-0 rounded-sm p-0 text-xs leading-4 font-normal text-muted-foreground hover:text-foreground" onClick={onShowFolder}>
          {place}
        </Button>
      </>
    );
  }
  // Cut in a narrow header, the whole line is in its tooltip: the line that needs him is never lost to an ellipsis.
  return (
    <TruncateTip text={words}>
      <p data-files-save-line={line.state} {...(needs ? { role: "status" } : {})} className={`min-w-0 truncate text-xs leading-4 ${needs ? "text-foreground" : "text-muted-foreground"}`}>
        {text}
      </p>
    </TruncateTip>
  );
}

/** Narrower than this, a file's header keeps the line's first press alone and its second is a row of ⋯ (`tuckedRows`). */
export const HEAD_NARROW = 480;

/**
 * The line's presses, at the header's end before the file's menu: at most two, the first the one he most likely
 * wants. Under 480px of header the second is drawn in ⋯ instead, so the name and the line keep room to be read.
 */
export function SaveActions({ actions, busy, onRun, tuck = true }: { actions: readonly SavedAction[]; busy: string | null; onRun(action: SavedAction): void; /** false where no file header holds them (a side file's bar): both presses always drawn */ tuck?: boolean }) {
  return (
    <>
      {actions.slice(0, 2).map((action, index) => (
        <Button key={action.id} variant={index === 0 ? "secondary" : "ghost"} size="xs" className={index === 0 || !tuck ? "shrink-0" : "hidden shrink-0 @[480px]/file-head:inline-flex"} disabled={busy !== null} onClick={() => onRun(action)}>
          <BusyLabel busy={busy === action.id} label={action.label} />
        </Button>
      ))}
    </>
  );
}

/** The id of the ⋯ row that stands for the line's second press in a narrow header. */
export const TUCKED = "save-line:second";

/** The file's menu with the line's second press first, where the header is too narrow to draw it. */
export function tuckedRows(rows: readonly MenuRow[], actions: readonly SavedAction[] | undefined, narrow: boolean, busy: string | null): MenuRow[] {
  const second = narrow ? actions?.[1] : undefined;
  return second ? [{ kind: "item", id: TUCKED, label: second.label, disabled: busy !== null }, { kind: "sep" }, ...rows] : [...rows];
}
