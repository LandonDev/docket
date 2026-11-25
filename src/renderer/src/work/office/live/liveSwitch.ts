import type { ConfirmRequest } from "../../../chrome/ConfirmDialog";
import type { LiveState } from "./layer";

/**
 * Switching a Files tab between Edit here and Live (docs/agents/work-office-live.md "Switching"). The host swaps the
 * tab's item (`work.office.live.set`); the window first makes sure nothing of his is lost on the way:
 * - to Live: what the kind still holds is flushed, then the host answers done, or asks: a copy whose file changed,
 *   went, did not answer or refused offers Keep Both or Cancel; a Word document whose edits are not in the Word file
 *   offers Save as Word… or Cancel. Never a quiet drop.
 * - to Edit here: the guest unloads first (Word may hold it while saving: the layer waits, then asks), and the host
 *   is told how much he typed, so it waits for OneDrive to bring Word's edits down before it opens the file. When
 *   nothing proves they came down the host keeps the tab live, and the guest comes back. Switch Anyway (Word let go
 *   mid-save) counts as typing and says `forced`: the host takes only a save of his, or keeps the seat. A save
 *   under another name asks "Is Dana Lee you?": That’s Me tells the host the name is his (`mine`), and it takes it.
 * The line says each wait from the press: "Opening in Word…" (or "Sending your changes first…") to Live; "Leaving
 * Word…", then "Opening it here…" to Edit here.
 */

export type LiveMode = "here" | "live";
export type LiveSetAnswer = { is: "done" } | { is: "ask"; why: "changed" | "gone" | "away" | "refused" | "word"; words: string } | { is: "ask"; why: "other"; name: string; words: string };

export interface SwitchDeps {
  set(params: { mode: LiveMode; typed?: number; quiet?: number; forced?: true; mine?: string; choice?: "keep-both" }): Promise<LiveSetAnswer>;
  /** What the tab's kind still holds reaches the host (canvas/flush.ts `flushedItem`); false when its send did not land. */
  flush(): Promise<boolean>;
  /** The guest unloads; false when he chose to stay (Word still saving), "forced" when he let Word go mid-save. */
  leave(): Promise<boolean | "forced">;
  /** The guest `leave` let go comes back in place: the host kept the tab live. */
  back(): void;
  /** Keys he typed in the live file. */
  typed(): Promise<number>;
  /** ms since his last key there, null before he typed: the host takes only a change made after it. */
  quiet?(): Promise<number | null>;
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
  /** Word, Excel or PowerPoint: the app the wait lines and asks name. */
  app: LiveApp;
}

/** One switch, asked and done. Answers whether the tab is now in `to`. */
export async function switchTo(to: LiveMode, from: SwitchFrom, deps: SwitchDeps): Promise<boolean> {
  try {
    const app = APP_NAME[from.app];
    if (to === "here") {
      const typed = await deps.typed();
      // His last key, read while the guest is there; the wait to leave is added, so the host times it from the press.
      const quiet = (await deps.quiet?.()) ?? null;
      const asked = Date.now();
      deps.busy(`Leaving ${app}…`);
      const left = await deps.leave();
      if (!left) return false;
      deps.busy("Opening it here…");
      // Word let go mid-save: nothing proves the file holds his edits, so the host waits for a save of his, else keeps the seat.
      const forced = left === "forced";
      const told = forced ? Math.max(typed, 1) : typed;
      let done = false;
      try {
        const params = { mode: "here" as const, typed: told, ...(quiet !== null ? { quiet: quiet + (Date.now() - asked) } : {}), ...(forced ? { forced: true as const } : {}) };
        let answer = await deps.set(params);
        // A save after his last key under another name: it may be his, under the name Office keeps for him.
        if (answer.is === "ask" && answer.why === "other" && (await deps.confirm({ title: `Is ${answer.name} you?`, body: answer.words, action: "That’s Me" })))
          answer = await deps.set({ ...params, mine: answer.name });
        done = answer.is === "done";
      } finally {
        if (!done) deps.back();
      }
      return done;
    }
    deps.busy(from.sending ? "Sending your changes first…" : `Opening in ${app}…`);
    // The item is replaced by the switch: an edit the kind could not send stops it, never goes with it.
    if (!(await deps.flush())) throw new Error(`Your last change to ${from.name} has not been saved yet. Try again in a moment.`);
    if (from.sending) deps.busy(`Opening in ${app}…`);
    let choice: "keep-both" | undefined;
    // At most one ask of each kind: a second refusal of the same kind is the host's last word.
    for (let tries = 0; tries < 3; tries++) {
      const answer = await deps.set({ mode: "live", ...(choice ? { choice } : {}) });
      if (answer.is === "done") return true;
      if (answer.why === "word") {
        if (!(await deps.confirm({ title: `Open ${from.name} in ${liveLabel(from.app)}?`, body: answer.words, action: `Save to ${from.service}` }))) return false;
        if (!(await deps.saveWord())) return false;
        continue;
      }
      if (choice) return false;
      if (!(await deps.confirm({ title: `Open ${from.name} in ${liveLabel(from.app)}?`, body: answer.words, action: "Keep Both" }))) return false;
      choice = "keep-both";
    }
    return false;
  } finally {
    deps.busy(null);
  }
}

/** The app a guest draws; Forms names a form's guest (LiveBody), never a file's. */
export const APP_NAME = { word: "Word", excel: "Excel", powerpoint: "PowerPoint", forms: "Forms" } as const;
export type LiveApp = keyof typeof APP_NAME;
/** The one name of the live mode (docs/DESIGN.md "The Files place"): "Word for the web", "Excel for the web", "PowerPoint for the web". */
export const liveLabel = (app: LiveApp): string => `${APP_NAME[app]} for the web`;
/** The app a live-able file's name implies, so the control keeps its place before the host answers. */
export function appOfName(name: string): Exclude<LiveApp, "forms"> | null {
  const ext = /\.(\w+)$/.exec(name)?.[1]?.toLowerCase();
  return ext === "docx" ? "word" : ext === "xlsx" || ext === "xlsm" ? "excel" : ext === "pptx" ? "powerpoint" : null;
}

/** A live tab's item: a Microsoft file by its web address (the host's seat for Live), drawn by Office for the web. */
export function liveSourceOf(item: { source: { at: string } } | null | undefined): { url: string; app: LiveApp } | null {
  const source = item?.source as { at: string; app?: string; ref?: { kind: string; url?: string } } | undefined;
  if (source?.at !== "microsoft" || source.ref?.kind !== "url" || !source.ref.url) return null;
  return source.app === "word" || source.app === "excel" || source.app === "powerpoint" ? { url: source.ref.url, app: source.app } : null;
}

const LIVE_NAME = /\.(docx|xlsx|xlsm|pptx)$/i;
/**
 * Whether a Files tab is asked about Office for the web: only the four forms it edits (the host's `LIVE_FORMS`), by the
 * tab's name or, for a Word file opened as the document made of it (the tab then carries the document's name), by the
 * file it is a copy of. A tab that is live now always is.
 */
export function offersLive(tab: { name: string; copyOf?: { path: string } }, live: boolean): boolean {
  return live || LIVE_NAME.test(tab.name) || LIVE_NAME.test(tab.copyOf?.path ?? "");
}

/**
 * A live tab's line while its guest comes up: "Signing in to Microsoft…" while the page is on a sign-in site (never its
 * address: redirects pass through several), "Opening in Word…" until the editor is up, then nothing (the place line).
 */
export function liveLine(state: LiveState, app: LiveApp): string | null {
  if (state.failed) return null;
  if (state.site) return "Signing in to Microsoft…";
  return state.stage !== "ready" ? `Opening in ${APP_NAME[app]}…` : null;
}
