/**
 * The two settings of live video (docs/agents/live-video.md "Settings"),
 * each a row in the host's settings table.
 */

/** The box's browser runs headed on its private display so its picture is video. On unless turned off; read when the browser starts. */
export const BROWSER_VIDEO_SETTING = 'work.browser.video'
/** A Mac's or a PC's own windows may be watched from another host of his. Off unless turned on, and only that machine's own desktop sets it. */
export const VIDEO_REMOTE_SETTING = 'computer.video.remote'

export const browserVideoOn = (value: string | null | undefined): boolean => value !== '0'
export const videoRemoteOn = (value: string | null | undefined): boolean => value === '1'
