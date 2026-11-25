import type { ReactNode } from "react";
import type { CanvasItem, CanvasKind, CanvasSource, ContextChip, HeldRef, Principal } from "@shared/work";
import type { IconComponent } from "../../chrome/icons";
import type { Chunk } from "../../lib/lazyChunk";

/**
 * What a canvas kind is and what it tells the pane around it
 * (docs/agents/work-canvas.md). The types live apart from the registry so a
 * pillar's `canvas.ts` can import them without importing every other kind.
 */

/** One canvas kind. `S` is the view state the pane keeps per item (scroll, tab, zoom) while its body is unmounted. */
export interface CanvasKindDef<S = unknown> {
  kind: CanvasKind;
  /** The kind as a person reads it: "Document", "Sheet". */
  label: string;
  icon: IconComponent;
  /** One item's glyph where the kind holds more than one sort of file (media: a video's glyph, else the picture's); absent, `icon`. */
  iconOf?(item: CanvasItem): IconComponent;
  /** What the kind claims. `kindFor` tries sources first, then the mime type, then the file extension. */
  opens: {
    sources?: Array<{ at: CanvasSource["at"]; app?: "excel" | "word" | "powerpoint"; table?: string }>;
    mime?: string[];
    /** lower case, no dot */
    ext?: string[];
  };
  /** How the phone shows it: its own native screen, or the hosted page in a web view. Every kind shows. */
  phone: "web" | "native";
  /** A guest link can be made for it: documents and sheets only. */
  guestable: boolean;
  /** The pane draws History in the kind's bar, which opens the item's versions as a `history` item beside it. Absent for a kind with no versions, and for one whose own bar draws its History. */
  history?: boolean;
  /** The kind's code, loaded when an item of the kind is first shown. `Body` fills the pane under the bars; `Bar` is the kind's own tools in the bar; `TabEnd` sits in the tab row before More (the switch to the real Excel or PowerPoint). */
  chunk: Chunk<CanvasKindModule<S>>;
}

/** A part of a kind: a function component over the item's props. */
export type CanvasPart<S = unknown> = (props: CanvasBodyProps<S>) => ReactNode;

export interface CanvasKindModule<S = unknown> {
  Body: CanvasPart<S>;
  Bar?: CanvasPart<S>;
  TabEnd?: CanvasPart<S>;
}

export interface CanvasBodyProps<S = unknown> {
  item: CanvasItem;
  source: CanvasSource;
  /** The host the thread, and so the item's row, lives on. */
  env: string;
  /** What this kind last kept for the item; undefined until it keeps something. */
  state: S | undefined;
  setState(next: S): void;
  shell: CanvasShell;
}

/**
 * What a kind tells the frame around it. Each call replaces what the kind
 * said before and null takes it back; the frame forgets all of it when the
 * item's body unmounts. The object is stable for an item, so an effect may
 * name it as a dependency.
 */
export interface CanvasShell {
  /** The pending changes: feeds the stepper at the end of the kind's bar. */
  review(adapter: ReviewAdapter | null): void;
  /** What the person selected: feeds the floating bar. Ask puts the chip in the thread's composer. */
  selection(selection: CanvasSelection | null): void;
  /** Ask from the kind's own selection menu (a document's): the chip goes in the thread's composer, a folded thread unfolds, the composer takes the caret. Optional only so a stand-in shell written before it still types. */
  ask?(chip: ContextChip): void;
  /** The other people in the item now: 20px avatars at the bar's start. */
  presence(people: Presence[]): void;
  /** What the agent does to this item. null (a kind's default): no mode, as a compare has none. */
  mode(mode: CanvasMode | null): void;
  /** The one state line across the item, for a source that cannot be reached or needs the person. Never a second banner. */
  statusLine(line: StatusLine | null): void;
  /** What the agent last wrote directly, in the stepper's place: "Wrote 6 cells, 2:04 PM", with Undo. */
  written(line: WrittenLine | null): void;
  /** Whether the item has opened. A kind that says false (still opening, or it could not open) has no History in its bar until it says true; one that never says is drawn as opened. Optional only so a stand-in shell written before it still types. */
  ready?(ready: boolean): void;
  /** One muted fact after the item's name while it is the only item (where a browser runs). */
  detail(text: string | null): void;
  /** Opens this item's versions beside it, as a `history` item on the same source. */
  openHistory(): void;
  /** Opens a held act of this item where held acts are shown (the Outbox). */
  held(ref: HeldRef): void;
  /** The kind's own verbs in the pane's More (Export transcript, Download recording), first, above the frame's own. The pane always gives it; it is optional only so a stand-in shell written before it (a proof page's) still types. */
  more?(entries: MoreEntry[] | null): void;
  /** What saved means for this item now: feeds the one line under a file's name where the item is open as a file (the Files place). A kind that never says is drawn by the frame's own rule. The pane always gives it; it is optional only so a stand-in shell written before it still types. */
  saved?(line: SavedLine | null): void;
}

/**
 * What saved means now (docs/agents/work-files.md "The seam with the editor builds"). There is no save press: a kind saves as he
 * works and says where that stands.
 *  - `saved`: everything is in the file; `at` is when, `where` the folder it is kept in.
 *  - `saving`: a change is on its way.
 *  - `offline`: the file cannot be reached; `pending` changes wait here.
 *  - `conflict`: the file changed under the item; `detail` says who and when, `actions` are Reload and Keep Both (Work's one conflict press).
 *  - `readonly`: it cannot be changed here; `detail` says why.
 *  - `copy`: this is a copy and its changes stay here; `detail` names the computer the file is on.
 *  - `downloading`: its bytes are coming; `detail` says how far.
 *  - `asleep`: its machine sleeps and this is what was kept; `at` is when.
 */
export type SavedState = "saved" | "saving" | "offline" | "conflict" | "readonly" | "copy" | "downloading" | "asleep";
export interface SavedLine {
  state: SavedState;
  /** epoch ms */
  at?: number;
  /** the folder's name, as the trail says it */
  where?: string;
  pending?: number;
  detail?: string;
  /** when his last edit not yet in the file was made (epoch ms), where the kind says: a Word file's line counts its pause from it */
  edited?: number;
  /** at most two presses, in order */
  actions?: SavedAction[];
}
export interface SavedAction {
  /** unique among the line's actions */
  id: string;
  label: string;
  run(): void | Promise<void>;
}

/** One of a kind's own rows in the pane's More: a 14px glyph and a verb, as every menu row is. */
export interface MoreEntry {
  /** Unique among the kind's entries. */
  id: string;
  label: string;
  icon: IconComponent;
  disabled?: boolean;
  /** A failure is said once, in the thread's toast stack. */
  run(): void | Promise<void>;
}

/** One way to review an agent's changes, whatever the kind: a document's suggestions, a sheet's cells, a deck's slides. */
export interface ReviewAdapter {
  /** One per branch or change set, in order. More than one: the stepper names the group the current change is in. */
  groups: Array<{ id: string; label: string; by: Principal; count: number }>;
  /** The current change, from 0, across all groups; -1 when the caret is in none. */
  index: number;
  /** Every pending change, across all groups. */
  count: number;
  /** Moves to a change; the kind scrolls it into view and outlines it. */
  step(to: number): void;
  /** Whether Next steps into the changes from none (`index` -1) and shows the first: absent, it does (a deck's slide, a document's caret). False where stepping from none shows nothing (a form's Responses), so Next is not lit there. */
  enter?: boolean;
  /** The changes are counted but cannot be decided now (a form while his edits save): the stepper stays drawn with its verbs off, and More's Accept all and Reject all are off. */
  held?: boolean;
  /** The changes can be stepped through but not yet decided (a slide whose picture is still coming or failed to paint): only Reject and Accept rest, with More's Accept all and Reject all; Previous and Next stay live, so focus stays in the bar and the other changes stay reachable. */
  verdictsHeld?: boolean;
  /** Accept cannot be made now and the kind's body says why (a recording's tasks while its host's LifeOS is down): Accept and More's Accept all are not offered; Reject, Reject all and the steps stay. */
  acceptHeld?: boolean;
  accept(which: number | { group: string } | "all"): Promise<void>;
  reject(which: number | { group: string } | "all"): Promise<void>;
}

export interface CanvasSelection {
  /** What Ask puts in the composer. */
  chip: ContextChip;
  /** Where the selection is on screen: the bar floats over it. */
  rect: DOMRect;
  /** Which edge of `rect` the bar lines up with: its start (the default), or its end (a slide's picked shape, clear of the Notes heading). */
  align?: "start" | "end";
  /** The kind's own controls, after Ask. */
  tools?: ReactNode;
}

export interface Presence {
  id: string;
  name: string;
  /** Their place in the presence palette (`--presence-1` to `--presence-8`): the colour of their caret or cell. */
  hue?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  image?: string;
}

export type CanvasModeValue = "suggests" | "writes";
export interface CanvasMode {
  value: CanvasModeValue;
  /** Absent: the mode shows and cannot be switched here. */
  set?(value: CanvasModeValue): void;
  /** One muted line in the menu saying why ("Others can edit this, so changes wait for you"). */
  note?: string;
}

export interface StatusLine {
  /**
   * failed: the source did not answer. needs: the person must act there (a sign-in), the one amber state. quiet: how
   * the item is, with nothing asked of him ("Read only"): one muted line, its press a link (`QuietLine`).
   */
  tone: "failed" | "needs" | "quiet";
  /** "LifeOS did not answer" */
  word: string;
  /** "Read only, as of 2:04 PM" */
  detail?: string;
  action?: { label: string; run(): void | Promise<void> };
  /** The word wraps beside the press, never cut: a word that is the whole fact and may be long (a computer's name). */
  wrap?: boolean;
  /** It is about a save the kind also tells through `saved`: where the save line is drawn (Files), it is said there alone. */
  saving?: boolean;
}

export interface WrittenLine {
  /** "Wrote 6 cells, 2:04 PM": the whole line, its time included */
  text: string;
  /** The words without the time ("Wrote 6 cells") and when it was written (epoch ms): where both are given, the bar
   *  says the words alone when the save line beside it already says that minute (KindBar `writtenWords`). */
  words?: string;
  at?: number;
  undo?(): Promise<void>;
}

/** A kind's definition as the registry holds it: its state type is the kind's own business. */
/** The glyph a tab and a lone item's title wear for an item: its own where its kind tells one, else the kind's. */
export const glyphOf = (def: CanvasKindDef, item: CanvasItem): IconComponent => def.iconOf?.(item) ?? def.icon;

export function defineCanvasKind<S>(def: CanvasKindDef<S>): CanvasKindDef {
  return def as unknown as CanvasKindDef;
}

