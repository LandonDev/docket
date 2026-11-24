import type { ConfirmRequest } from "../../../chrome/ConfirmDialog";

/**
 * Switching a Files tab between Edit here and Live (docs/agents/work-office-live.md "Switching"). The host swaps the
 * tab's item (`work.office.live.set`); the window first makes sure nothing of his is lost on the way:
 * - to Live: what the kind still holds is flushed, then the host answers done, or asks: a copy whose file changed,
 *   went, did not answer or refused offers Keep Both or Cancel; a Word document whose edits are not in the Word file
 *   offers Save as Word… or Cancel. Never a quiet drop.
 * - to Edit here: the guest unloads first (Word may hold it while saving: the layer waits, then asks), and the host
 *   is told how much he typed, so it waits for OneDrive to bring Word's edits down before it opens the file.
 */

export type LiveMode = "here" | "live";
export type LiveSetAnswer = { is: "done" } | { is: "ask"; why: "changed" | "gone" | "away" | "refused" | "word"; words: string };

export interface SwitchDeps {
  set(params: { mode: LiveMode; typed?: number; choice?: "keep-both" }): Promise<LiveSetAnswer>;
  /** What the tab's kind still holds reaches the host (canvas/flush.ts). */
  flush(): Promise<void>;
  /** The guest unloads; false when he chose to stay (Word still saving). */
  leave(): Promise<boolean>;
  /** Keys he typed in the live file. */
  typed(): Promise<number>;
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** Save to Teams as Word (wordSave.ts), its own confirm included; true once the Word file holds his edits. */
  saveWord(): Promise<boolean>;
  /** The tab's line while the switch waits, or null. */
  busy(line: string | null): void;
}

export interface SwitchFrom {
  name: string;
  /** Teams, OneDrive: where the file is kept, as the Word line names it. */
  service: string;
  /** The tab is a copy that saves back: its changes go first. */
  sending: boolean;
}

/** One switch, asked and done. Answers whether the tab is now in `to`. */
export async function switchTo(to: LiveMode, from: SwitchFrom, deps: SwitchDeps): Promise<boolean> {
  try {
    if (to === "here") {
      const typed = await deps.typed();
      if (!(await deps.leave())) return false;
      if (typed > 0) deps.busy(`Getting the newest from ${from.service}…`);
      return (await deps.set({ mode: "here", typed })).is === "done";
    }
    if (from.sending) deps.busy("Sending your changes first…");
    await deps.flush();
    let choice: "keep-both" | undefined;
    // At most one ask of each kind: a second refusal of the same kind is the host's last word.
    for (let tries = 0; tries < 3; tries++) {
      const answer = await deps.set({ mode: "live", ...(choice ? { choice } : {}) });
      if (answer.is === "done") return true;
      if (answer.why === "word") {
        if (!(await deps.confirm({ title: `Open ${from.name} live?`, body: answer.words, action: `Save to ${from.service} as Word…` }))) return false;
        if (!(await deps.saveWord())) return false;
        continue;
      }
      if (choice) return false;
      if (!(await deps.confirm({ title: `Open ${from.name} live?`, body: answer.words, action: "Keep Both" }))) return false;
      choice = "keep-both";
    }
    return false;
  } finally {
    deps.busy(null);
  }
}

/** "Live in Word", "Live in Excel", "Live in PowerPoint". */
export const APP_NAME = { word: "Word", excel: "Excel", powerpoint: "PowerPoint" } as const;
export type LiveApp = keyof typeof APP_NAME;
export const liveLabel = (app: LiveApp): string => `Live in ${APP_NAME[app]}`;

/** A live tab's item: a Microsoft file by its web address (the host's seat for Live), drawn by Office for the web. */
export function liveSourceOf(item: { source: { at: string } } | null | undefined): { url: string; app: LiveApp } | null {
  const source = item?.source as { at: string; app?: string; ref?: { kind: string; url?: string } } | undefined;
  if (source?.at !== "microsoft" || source.ref?.kind !== "url" || !source.ref.url) return null;
  return source.app === "word" || source.app === "excel" || source.app === "powerpoint" ? { url: source.ref.url, app: source.app } : null;
}
