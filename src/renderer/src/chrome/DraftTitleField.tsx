import { DRAFT_TITLE_MAX } from "../lib/session";

/**
 * An unsent draft's name in the composer's draft row: one line, at most
 * `DRAFT_TITLE_MAX` characters, sized to its words (the placeholder when
 * empty) and giving way before the row's pickers do (`shrink-100`: it takes
 * the row's whole squeeze until it is at its least, and only then does the
 * folder's name narrow); under a 24rem row (folder, type and Master
 * thread leave it no more than "Name…") it is gone, and under a 32rem row
 * that also holds the host picker (at 800px it cut the folder to "Ho…"). It reads as the row's
 * other controls, 12px muted with their hover fill and no border at rest;
 * focus draws the field's ring and the typed name takes the foreground.
 * Enter hands focus to the message, Escape too. The first send creates the
 * thread with it as its title (`session.create { title }`); left empty, the
 * host names the thread from the message as before.
 */
export function DraftTitleField({
  value,
  onChange,
  onDone,
}: {
  value: string;
  onChange: (title: string) => void;
  /** Back to the message field. */
  onDone: () => void;
}) {
  // Every keystroke renders it anew, so the compiler's memo cells buy nothing and the first paint pays for them.
  "use no memo";
  return (
    <input
      data-composer-title
      type="text"
      value={value}
      maxLength={DRAFT_TITLE_MAX}
      placeholder="Name this thread"
      aria-label="Thread name"
      // Under a 24rem row (32rem with the host picker in it) it gives way whole, never cut to "Name…" with the folder cut
      // beside it; above it, it takes the squeeze first (shrink-100).
      className="focus-field h-6 min-w-16 shrink-100 text-ellipsis @max-[24rem]/draft-row:hidden group-has-[[data-draft-host-picker]]/draft-row:@max-[32rem]/draft-row:hidden rounded-md border border-transparent px-1.5 text-xs text-foreground field-sizing-content placeholder:text-muted-foreground hover:bg-foreground/5"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== "Escape") return;
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        onDone();
      }}
    />
  );
}
