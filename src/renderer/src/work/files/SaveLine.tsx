import type { ReactNode } from "react";
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
  return (
    <p data-files-save-line={line.state} {...(needs ? { role: "status" } : {})} className={`min-w-0 truncate text-xs leading-4 ${needs ? "text-foreground" : "text-muted-foreground"}`}>
      {text}
    </p>
  );
}

/** The line's presses, at the header's end before the file's menu: at most two, the first the one he most likely wants. */
export function SaveActions({ actions, busy, onRun }: { actions: readonly SavedAction[]; busy: string | null; onRun(action: SavedAction): void }) {
  return (
    <>
      {actions.slice(0, 2).map((action, index) => (
        <Button key={action.id} variant={index === 0 ? "secondary" : "ghost"} size="xs" className="shrink-0" disabled={busy !== null} onClick={() => onRun(action)}>
          <BusyLabel busy={busy === action.id} label={action.label} />
        </Button>
      ))}
    </>
  );
}
