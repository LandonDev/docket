/**
 * One right edge for money (docs/DESIGN.md "The Money view"): By category's amounts, Entries' Amount
 * column, Owed's amounts and To confirm's amounts all end 120px inside the column's right edge, and
 * what follows an amount (a paperclip, Paid, Review and a row's menu) sits in those 120px, ending on the
 * column's edge. Each list's last track is sized so its amount lands there; change the 120 in all four
 * together. Whole class strings, so Tailwind finds them.
 */

/** By category: name, the bar, the amount, then 104px empty (+16px gap = 120). */
export const CATEGORY_GRID = "grid-cols-[minmax(0,12rem)_minmax(0,1fr)_7rem_104px]";

/** Entries: the paperclip's column, 116px (the table hangs 8px past the column; the amount cell's 12px padding: 8 + 120 = 116 + 12). */
export const ENTRIES_TAIL = "w-[116px]";

/** Owed: who and for what, how long, the amount, then Paid in 104px (+16px gap = 120). */
export const OWED_GRID = "grid-cols-[minmax(0,1fr)_5rem_6rem_104px]";

/** To confirm: the picture, the words, the amount, then the verb and the menu in 108px (+12px gap = 120). */
export const TO_CONFIRM_GRID = "grid-cols-[2rem_minmax(0,1fr)_6rem_108px]";
