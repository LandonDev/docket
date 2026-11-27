/**
 * The selected slide, in the strip, the Sorter and the presenter's strip (docs/DESIGN.md "Slides by hand"): a 2px
 * `accent` ring around its frame, outside the picture with the frame's 3px between (6px corners over the picture's
 * 3px), and its number in semibold `foreground`. Hover is only the frame's quiet fill. Drawn at once, never faded:
 * the arrows move it.
 */
export const SLIDE_PICKED = "outline-2 outline-offset-0 outline-accent";
export const NUMBER_PICKED = "font-semibold text-foreground";
