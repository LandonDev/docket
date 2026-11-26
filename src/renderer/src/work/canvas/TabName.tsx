import type { Ref } from "react";

/**
 * A name cut in its middle (decision 13 of the files pass): the start gives way first, down to a letter or two and
 * its ellipsis, and the end from `keep` on stays, so the part that tells it from its neighbours is what he reads
 * ("Purdue Es…Budget.xlsx", "Dummy Esp… › Spring LAN"). Read whole; the two drawn parts are for the eye. A space at
 * the start's end or the end's start would be dropped at the cut, so it is kept unbreaking. The end never shrinks (an ellipsis shows at
 * any part of a pixel lost, so a small share would still cut it): it takes the room it needs up to all but 1.5em,
 * and the start, down to that 1.5em, its ellipsis and perhaps a letter, takes the rest. Its tip (`useTruncated`)
 * sees either part cut.
 */
export function MiddleCut({ text, keep, ref, className = "", startClass = "", endClass = "", startRoom, tail = false }: { text: string; keep: number; ref?: Ref<HTMLSpanElement>; className?: string; startClass?: string; endClass?: string; /** the start's least room, where it must stay readable (a search's place: 4em) */ startRoom?: string; /** an end too long for its room is cut at its start, so its own end, the part that differs, stays */ tail?: boolean }) {
  const end = text.slice(keep);
  return (
    <span ref={ref} data-middle-cut className={`flex min-w-0 ${className}`}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className={`min-w-[1.5em] truncate ${startClass}`} style={startRoom ? { minWidth: startRoom } : undefined}>
        {text.slice(0, keep).replace(/ $/, "\u00a0")}
      </span>
      {/* Cut at its start: laid right to left, the words kept left to right inside, so the ellipsis leads. */}
      <span aria-hidden data-middle-tail={tail || undefined} dir={tail ? "rtl" : undefined} className={`max-w-[calc(100%-1.5em)] shrink-0 truncate ${tail ? "text-left" : ""} ${endClass}`} style={startRoom ? { maxWidth: `calc(100% - ${startRoom})` } : undefined}>
        {tail ? <bdi dir="ltr">{end.replace(/^ /, "\u00a0")}</bdi> : end.replace(/^ /, "\u00a0")}
      </span>
    </span>
  );
}

/**
 * Where a lone long name keeps its end when cut: its last word ("TempCode p…Walk"), as Finder cuts in its middle. Null
 * for one word, and for a name of 16 letters or fewer, which a 200px sidebar row holds whole beside its glyph and chevron.
 */
export const lastWord = (name: string): number | null => {
  const at = name.trimEnd().lastIndexOf(" ");
  return name.length > 16 && at > 0 ? at + 1 : null;
};

/** Whether `keep` cuts `text` in its middle: something before it and something after. */
export const cutsMiddle = (text: string, keep: number | null | undefined): keep is number => keep != null && keep > 0 && keep < text.length;

/** The letters a tab's 5.5rem of name holds whole at the tab's type. */
const WHOLE_IN_TAB = 12;

/**
 * A tab's name in Files' row (files/TabRow.tsx) and the canvas tab row (CanvasTabs.tsx) alike. Squeezed under the room
 * of one letter and its ellipsis, the name gives way whole, and the tab is its glyph alone (docs/DESIGN.md "Spacing":
 * the least fact gives way first, and whole), never a sliver of its first letter. The name stays its accessible name,
 * and its tip still shows it whole. The name's box is a container, so it is measured by the room the tab gives it;
 * an unseen copy of the name beside it (the `::before`, from `data-name`) gives the tab its width while it has room.
 * With `keep` (tabShrink.ts `tabEnds`: open tabs share a start) the name is cut in its middle (`MiddleCut`).
 */
export function TabName({ name, keep = null, titleRef }: { name: string; keep?: number | null; titleRef: (el: HTMLElement | null) => void }) {
  // A name 5.5rem holds whole is drawn whole: its middle cut would hide its start in a tab no wider than itself, and
  // "Sponsors" beside "Sponsor deck.pptx" would read "s".
  const cut = name.length > WHOLE_IN_TAB && cutsMiddle(name, keep);
  return (
    <span
      data-tab-name={name}
      className="grid min-w-0 before:invisible before:col-start-1 before:row-start-1 before:h-0 before:overflow-hidden before:whitespace-nowrap before:content-[attr(data-tab-name)]"
    >
      <span className="@container/tab-name col-start-1 row-start-1 min-w-0">
        {cut ? (
          // Under 5.5rem a start's ellipsis would leave the end a sliver: the end alone is drawn, cut at its own end, so
          // a 128px tab (70px of name) reads "Pages.pdf" whole, never "T…Page…".
          <MiddleCut ref={titleRef} text={name} keep={keep!} className="@max-[1.25rem]/tab-name:sr-only" startClass="@max-[5.5rem]/tab-name:hidden" endClass="@max-[5.5rem]/tab-name:max-w-full" />
        ) : (
          <span ref={titleRef} className="block min-w-0 truncate @max-[1.25rem]/tab-name:sr-only">
            {name}
          </span>
        )}
      </span>
    </span>
  );
}
