import { EditorSelection, type Text } from "@codemirror/state";
import type { TextReader } from "./fileSession";

/** Where he was in a text file: kept by the item's body across a text replaced from the host (a Reload). */
export interface TextPlace {
  top: number;
  head: number;
}

/** An edit's text as the session takes it: its length now, its characters only when read (a key copies nothing). */
export const handOver = (doc: Text): TextReader => ({ length: doc.length, read: () => doc.toString() });

/** The caret a new text opens with: where he was, held to its end; none where he was nowhere yet. */
export const openingCaret = (place: TextPlace | null, text: string): EditorSelection | undefined => (place ? EditorSelection.single(Math.min(place.head, text.length)) : undefined);
