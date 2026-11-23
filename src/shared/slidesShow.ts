/**
 * A show's windows, as main, the preload and the slides canvas all name them
 * (src/main/present.ts, docs/agents/work-slides.md "The show"). No zod and no
 * values but one prefix, so the preload and the app's first paint carry
 * nothing of the slides pillar.
 */

/** The two surfaces of a show: the slideshow the room sees, and the presenter's view. */
export type ShowSurface = 'audience' | 'presenter'

/**
 * How he asked to present. `full`: the slideshow full screen, with the
 * presenter's view on his own display when there is a second one.
 * `presenter`: the same with two displays; with one, the presenter's view
 * alone in a window (a rehearsal). `windowed`: the slideshow in a window
 * and the presenter's view beside it, both on his own display.
 */
export type ShowMode = 'full' | 'presenter' | 'windowed'

export interface ShowAsk {
  mode: ShowMode
  /** the display the slideshow goes on, full screen; the other one by default */
  display?: number
}

/** A display as the Present menu lists it. */
export interface ShowDisplay {
  id: number
  label: string
  /** the display his window is on */
  own: boolean
}

/**
 * What main answers a page that asked for a show: the frame name to open each window under, or null for a
 * surface this show has no window for. The names are made for this one show, so nothing else in the page
 * (a frame that could open a popup) can ask for a show's window by a name it knows.
 */
export type ShowFrames = Record<ShowSurface, string | null>

/** Every frame name of a show starts with this. */
export const SHOW_FRAME_PREFIX = 'tc-show-'
