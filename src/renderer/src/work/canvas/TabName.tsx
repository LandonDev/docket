import type { Ref } from "react";

/**
 * A name cut in its middle (decision 13 of the files pass): the start gives way first, down to a letter or two and
 * its ellipsis, and the end from `keep` on stays, so the part that tells it from its neighbours is what he reads
 * ("Purdue Es…Budget.xlsx", "Dummy Esp… › Spring LAN"). Read whole; the two drawn parts are for the eye. A space at
 * the start's end would be dropped at the cut, so it is kept unbreaking. The end never shrinks (an ellipsis shows at
 * any part of a pixel lost, so a small share would still cut it): it takes the room it needs up to all but 1.5em,
 * and the start, down to that 1.5em, its ellipsis and perhaps a letter, takes the rest. Its tip (`useTruncated`)
 * sees either part cut.
 */
export function MiddleCut({ text, keep, ref, className = "", startClass = "", endClass = "" }: { text: string; keep: number; ref?: Ref<HTMLSpanElement>; className?: string; startClass?: string; endClass?: string }) {
  return (
    <span ref={ref} data-middle-cut className={`flex min-w-0 ${className}`}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className={`min-w-[1.5em] truncate ${startClass}`}>
        {text.slice(0, keep).replace(/ $/, "\u00a0")}
      </span>
      <span aria-hidden className={`max-w-[calc(100%-1.5em)] shrink-0 truncate ${endClass}`}>
        {text.slice(keep)}
      </span>
    </span>
  );
}

/** Whether `keep` cuts `text` in its middle: something before it and something after. */
export const cutsMiddle = (text: string, keep: number | null | undefined): keep is number => keep != null && keep > 0 && keep < text.length;

/**
 * A tab's name in Files' row (files/TabRow.tsx) and the canvas tab row (CanvasTabs.tsx) alike. Squeezed under the room
 * of one letter and its ellipsis, the name gives way whole, and the tab is its glyph alone (docs/DESIGN.md "Spacing":
 * the least fact gives way first, and whole), never a sliver of its first letter. The name stays its accessible name,
 * and its tip still shows it whole. The name's box is a container, so it is measured by the room the tab gives it;
 * an unseen copy of the name beside it (the `::before`, from `data-name`) gives the tab its width while it has room.
 * With `keep` (tabShrink.ts `tabEnds`: open tabs share a start) the name is cut in its middle (`MiddleCut`).
 */
export function TabName({ name, keep = null, titleRef }: { name: string; keep?: number | null; titleRef: (el: HTMLElement | null) => void }) {
  return (
    <span
      data-tab-name={name}
      className="grid min-w-0 before:invisible before:col-start-1 before:row-start-1 before:h-0 before:overflow-hidden before:whitespace-nowrap before:content-[attr(data-tab-name)]"
    >
      <span className="@container/tab-name col-start-1 row-start-1 min-w-0">
        {cutsMiddle(name, keep) ? (
          // Under 4rem a start's ellipsis would leave the end a sliver: the end alone is drawn, cut at its own end.
          <MiddleCut ref={titleRef} text={name} keep={keep} className="@max-[1.25rem]/tab-name:sr-only" startClass="@max-[4rem]/tab-name:hidden" endClass="@max-[4rem]/tab-name:max-w-full" />
        ) : (
          <span ref={titleRef} className="block min-w-0 truncate @max-[1.25rem]/tab-name:sr-only">
            {name}
          </span>
        )}
      </span>
    </span>
  );
}
