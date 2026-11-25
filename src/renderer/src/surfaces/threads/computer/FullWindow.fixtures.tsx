// Every state of full screen for a computer being driven, for `bun run ui:preview
// src/renderer/src/surfaces/threads/computer/FullWindow.preview.tsx#FullWindowStates`
// and the dom test that keeps them honest. The pictures are the recorded app
// fixtures (src/main/server/computer/fixtures/apps): scratch content only.
import type { PreviewState } from "../../../lib/computerPreview";
import type { ComputerTile } from "../../../lib/computers";
import { BOX_BROWSER_BUNDLE } from "../../../lib/computerSessions";
import type { FullWindowViewProps } from "./FullWindow";
import { pictureClass, type LiveStream } from "./Viewport";

const still = (app: string, state: string): string => new URL(`../../../../../main/server/computer/fixtures/apps/${app}/${state}/window.jpg`, import.meta.url).href;
const PAGE = { width: 1200, height: 800 };
const noop = (): void => {};

export const streamOf = (state: PreviewState, mode: LiveStream["mode"] = "video", drive: LiveStream["drive"] = null): LiveStream => ({ state, retry: noop, canvas: { current: null }, ring: { current: null }, mode, drive });
/** A stream he drives from the place that shows it: its box takes the keyboard. */
export const driven: NonNullable<LiveStream["drive"]> = { send: noop, paste: async () => undefined, copy: async () => null };
const live = (size = PAGE): PreviewState => ({ status: "live", app: "Chromium", window: "Expense report", ...size, drawn: true });

export const tile = (over: Partial<ComputerTile> = {}): ComputerTile => ({
  id: "box\nt1",
  entry: {
    host: "box",
    row: { threadId: "t1", since: 1, lastCallAt: 1, apps: [{ name: "Chromium", bundleId: BOX_BROWSER_BUNDLE, window: "Expense report" }], running: null, tier: null },
    previewable: true,
    previewHost: "box",
    previewKey: "t1",
  },
  title: "File the March expense report",
  doing: "Clicking Submit in Chromium",
  where: "The box",
  driving: false,
  browser: true,
  pane: "t1",
  shownOn: null,
  computer: "browser:t1",
  idle: false,
  ...over,
});

/** A stand-in for the Windows VM's 1280 by 800 screen: a one-pixel grid, so a shot shows how its pixels are drawn. */
export const VM_STILL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" shape-rendering="crispEdges"><defs><pattern id="g" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0H8M0 0V8" stroke="#3a6ea5" stroke-width="1"/></pattern></defs><rect width="1280" height="800" fill="#0b2a4a"/><rect width="1280" height="800" fill="url(#g)"/><rect y="760" width="1280" height="40" fill="#1c1c1c"/><text x="40" y="80" font-family="Segoe UI, sans-serif" font-size="24" fill="#ffffff">Windows VM, 1280 by 800</text></svg>',
)}`;

export interface FullWindowFixture {
  name: string;
  props: FullWindowViewProps;
}

const page = <img src={still("finder", "folder")} alt="" draggable={false} className={pictureClass(true)} />;
// a 1440×900 display at 2×; the picture's own pixels are 600 by 400, so a window's is drawn at most 1200 by 800
const ROOM = { width: 1440, height: 900 };
/** The Windows VM's screen at 1280 by 800: a grid of its pixels (ComputersView.fixtures.tsx). */
export const vmPicture = <img src={VM_STILL} alt="" draggable={false} className={pictureClass(true)} />;
const VM = { status: "live", app: "Windows VM", window: null, width: 1280, height: 800, drawn: true } as const;
export const vmTile = tile({ title: "Windows VM", doing: null, browser: false, computer: "vm:windows", where: "The box", idle: true, pane: "vm:windows" });
const base = { room: ROOM, name: "Live view of Expense report in Chromium", dpr: 2, onExit: noop, onOpenSession: noop } as const;

const fixtures: FullWindowFixture[] = [
  { name: "The Windows VM fills the MacBook's display (1728 by 1117 points): 1728 by 1080, its full width", props: { ...base, room: { width: 1728, height: 1117 }, tile: vmTile, stream: streamOf(VM), picture: vmPicture } },
  { name: "The agent drives the box's browser: the picture as large as the window allows, its caption under it", props: { ...base, tile: tile(), stream: streamOf(live()), picture: page } },
  { name: "He drives: the caption says so, and offers Hand back alone; the picture takes his keys and pointer", props: { ...base, tile: tile({ driving: true, doing: null }), stream: streamOf(live(), "video", driven), picture: page } },
  { name: "The pointer rested: the caption has faded", props: { ...base, tile: tile(), stream: streamOf(live()), picture: page, captionShown: false } },
  { name: "A window on a Mac: no driver to speak of, Stop alone", props: { ...base, tile: tile({ browser: false, computer: "window:t1", title: "Tidy the Downloads folder", where: "Landon's MacBook" }), stream: streamOf(live(), "picture"), picture: page } },
  { name: "A small window: the picture scaled down whole", props: { ...base, room: { width: 640, height: 520 }, tile: tile(), stream: streamOf(live()), picture: page } },
  { name: "On its way: the skeleton in the picture's shape", props: { ...base, room: { width: 900, height: 700 }, tile: tile(), stream: streamOf({ status: "starting", ...PAGE }) } },
  { name: "The stream ended and can be tried again", props: { ...base, room: { width: 900, height: 700 }, tile: tile(), stream: streamOf({ status: "ended", reason: "error" }) } },
  { name: "Nothing drives it any more", props: { ...base, room: { width: 900, height: 700 }, tile: null, stream: streamOf({ status: "starting" }) } },
];

export default fixtures;
