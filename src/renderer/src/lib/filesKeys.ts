/**
 * The Files place's own chords. While focus is inside the Files view, a few of
 * the app's chords act on the Files tabs instead, as a focused editor keeps
 * its own (lib/appCommands.ts guard 7; the menu route through `filesOverlay`).
 * First-paint code: the port alone. The lazy Files view fills it while it is
 * mounted, with the rule for whose focus it is, the reader of its chords and
 * the menu rows they answer (work/files/chords.ts).
 */

/** What the Files place does with a chord the app would otherwise take. */
export type FilesCommand = "new-tab" | "close-tab" | "next-tab" | "prev-tab" | "back" | "forward" | "go-to" | "search" | "reopen-tab";

/**
 * What the Files view brings with its chunk: whether focus is its own (inside the view, and not in a dialog or a
 * menu there), the reader of its chords, and the menu rows whose keys are those chords, each with its command.
 */
export interface FilesKeys {
  owns(target: EventTarget | null): boolean;
  chord(e: KeyboardEvent): FilesCommand | null;
  menu: Readonly<Record<string, FilesCommand>>;
}

let handler: ((command: FilesCommand) => void) | null = null;
let keys: FilesKeys | null = null;

/**
 * The Files view registers its handler while it is mounted, with its keys (`FILES_KEYS`, work/files/chords.ts:
 * they ride the view's chunk, not the first paint); `run` answers whether one took the command.
 */
export const filesPort = {
  set(run: ((command: FilesCommand) => void) | null, own: FilesKeys | null = null): void {
    handler = run;
    keys = run ? own : null;
  },
  run(command: FilesCommand): boolean {
    if (!handler) return false;
    handler(command);
    return true;
  },
  /** The chord's Files command while the view is mounted, else null. */
  chord: (e: KeyboardEvent): FilesCommand | null => keys?.chord(e) ?? null,
  /** The Files command a menu row runs while the view is mounted, else undefined. */
  menu: (id: string): FilesCommand | undefined => keys?.menu[id],
  /** Whether focus is the Files view's own: false while none is mounted. */
  owns: (target: EventTarget | null): boolean => keys?.owns(target) ?? false,
  mounted: (): boolean => handler !== null,
};
