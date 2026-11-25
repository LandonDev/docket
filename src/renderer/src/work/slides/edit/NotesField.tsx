import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { DeckSlide } from "@shared/contract-work-slides";
import { Textarea } from "../../../components/ui/textarea";
import { notesShown, notesTyped } from "../notesText";
import type { HandSession } from "./session";

/** The most of a slide's notes the deck's outline carries (the deck tool's `TEXT_CAP`): notes this long may be cut. */
export const NOTES_SHOWN_MAX = 20_000;
/** Notes the outline may have cut: words he cannot type in, so a key never saves them cut (the host refuses it too). */
export const notesCut = (slide: Pick<DeckSlide, "notes">): boolean => slide.notes.length >= NOTES_SHOWN_MAX;

/**
 * The slide's speaker notes as a field he types in (docs/DESIGN.md "The slide editor"), where he can edit the deck
 * by hand: plain words under a 12px "Notes", in the notes' own 14/22, kept as the box's words are (a 2 s pause,
 * leaving the field, Escape, the stage leaving the slide), each one `notes` edit over the notes it began from.
 */
export function NotesField({ slide, session }: { slide: DeckSlide; session: HandSession }) {
  const id = useId();
  // Drawn again (the stage back on the slide) while his words are not in the file yet: it starts from them.
  const [text, setText] = useState(() => session.pendingNotes(slide.id) ?? slide.notes);
  const began = useRef(slide.notes);
  // The deck's notes as they come, unless his own are not in the file yet: those stay in the field. His Reload over
  // notes changed elsewhere takes the deck's again.
  const reloads = useSyncExternalStore(session.subscribe, () => session.get().notesReload ?? 0);
  useEffect(() => {
    if (session.notesPending(slide.id)) return;
    setText(slide.notes);
    began.current = slide.notes;
  }, [session, slide.id, slide.notes, reloads]);
  // The stage leaving the slide (or the tab closing) keeps what he typed.
  useEffect(() => () => void session.keepNotes(), [session]);
  return (
    <div data-slide-notes className="shrink-0 px-5 pt-4 pb-4">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        Notes
      </label>
      <Textarea
        id={id}
        data-slide-notes-field
        value={notesShown(text)}
        rows={1}
        placeholder="Add notes"
        className="-mx-2.5 min-h-0 max-w-[70ch] resize-none border-transparent px-2.5 py-1 text-sm leading-[22px] text-pretty"
        onChange={(event) => {
          // A line break inside a paragraph shows as a line and goes back as one (notesText.ts).
          const typed = notesTyped(event.target.value, text);
          setText(typed);
          session.typeNotes(slide.id, typed, began.current);
        }}
        onBlur={() => void session.keepNotes()}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          // Escape keeps his words and gives the keyboard back to the slide, as the typing box does.
          event.preventDefault();
          event.stopPropagation();
          void session.keepNotes();
          event.currentTarget.closest("[data-slides-main]")?.querySelector<HTMLElement>("[data-slides-shapes]")?.focus({ preventScroll: true });
        }}
      />
    </div>
  );
}
