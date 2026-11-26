/**
 * One right edge for money (docs/DESIGN.md "The Money view"): By category's amounts, Entries' Amount
 * column, Owed's amounts and To confirm's amounts all end 120px inside the column's right edge, and
 * what follows an amount (a paperclip, Paid, Review and a row's menu) sits in those 120px, ending on the
 * column's edge. Each list's last track is sized so its amount lands there; change the 120 in all four
 * together. Whole class strings, so Tailwind finds them.
 *
 * Under 640px (the view's `money` container; the smallest window beside the rail gives about 600) By category and
 * Entries end their amounts 48px in, the paperclip's room, and give the rest to the names; Owed and To confirm keep
 * their 120px, since a press (Paid, Review) stands there, and Owed's days move under the name. The header's own rule
 * (`NARROW_HEAD`) is its 520px.
 */

/**
 * By category: name, the bar, the amount, then 104px empty (+16px gap = 120); under 640px 32px (+16 = 48), the name
 * and the bar sharing the rest, so a bar stands beside its name on a scale that reads (never a 3rem stub far from it);
 * under 480px the bar goes (`CATEGORY_BAR`).
 */
export const CATEGORY_GRID = "grid-cols-[minmax(0,12rem)_minmax(0,1fr)_7rem_104px] @max-[640px]/money:grid-cols-[minmax(0,1fr)_minmax(3rem,1fr)_7rem_32px] @max-[480px]/money:grid-cols-[minmax(0,1fr)_7rem_32px]";

/** By category's bar: under 480px it goes whole, the amount beside it saying the same, so the name keeps the room. */
export const CATEGORY_BAR = "@max-[480px]/money:hidden";

/** Entries: the paperclip's column, 116px (the table hangs 8px past the column; the amount cell's 12px padding: 8 + 120 = 116 + 12); under 640px 44px (8 + 48 = 44 + 12). */
export const ENTRIES_TAIL = "w-[116px] @max-[640px]/money:w-[44px]";

/**
 * Owed: who and for what, how long, the amount, then Paid in 104px (+16px gap = 120). Under 640px how long gives way
 * and reads as the name's second line, so who owes keeps the room beside Paid.
 */
export const OWED_GRID = "grid-cols-[minmax(0,1fr)_5rem_6rem_104px] @max-[640px]/money:grid-cols-[minmax(0,1fr)_5rem_104px]";

/**
 * Owed's who and what: one line cut at the end, and under 640px one run of words that wraps, so a long first fact
 * never cuts the second beside a live Paid. `OWED_LINE` on the pair, `OWED_FACT` on each fact.
 */
export const OWED_LINE = "flex min-w-0 items-baseline gap-1 @max-[640px]/money:block";
export const OWED_FACT = "truncate @max-[640px]/money:inline @max-[640px]/money:whitespace-normal";

/** To confirm: the picture, the words, the amount, then the verb and the menu in 108px (+12px gap = 120). */
export const TO_CONFIRM_GRID = "grid-cols-[2rem_minmax(0,1fr)_6rem_108px]";

/** Under 640px: Entries' Category column gives way, and the category reads as Who's second line. */
export const WIDE_ONLY = "@max-[640px]/money:hidden";
export const NARROW_ONLY = "hidden @max-[640px]/money:block";

/**
 * Month or Year in the 40px header, hidden under 520px of the header's content box (the frame's `viewhead`
 * container: a container query measures the box inside its padding, and Tailwind's `@max-` is `width < 520px`).
 */
export const WIDE_HEAD = "flex @max-[520px]/viewhead:hidden";

/** The header's content width under which Month or Year moves into More, so Add and More stay in sight. */
export const NARROW_HEAD = 520;

/**
 * Whether Month or Year has left the header for More: the header's content box, the box inside its padding the
 * container query measures, under `NARROW_HEAD` (a width of 0 is a header not laid out yet). One boundary with
 * WIDE_HEAD. The width is the layout's own, fractional (ResizeObserver's content box): an integer `clientWidth` rounds
 * 543.75px up to 544 while the query hides the toggle at 519.75px of content.
 */
export function headIsNarrow(contentWidth: number): boolean {
  return contentWidth > 0 && contentWidth < NARROW_HEAD;
}
