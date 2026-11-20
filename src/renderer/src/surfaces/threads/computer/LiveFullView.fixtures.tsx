// Every state of the full view of a computer being driven, for `bun run ui:preview
// src/renderer/src/surfaces/threads/computer/LiveFullView.preview.tsx#FullViewStates`
// and the dom test that keeps them honest. The pictures are the recorded app
// fixtures (src/main/server/computer/fixtures/apps): scratch content only.
import type { PreviewState } from "../../../lib/computerPreview";
import type { ComputerTile } from "../../../lib/computers";
import { BOX_BROWSER_BUNDLE } from "../../../lib/computerSessions";
import type { FullViewProps } from "./LiveFullView";
import { pictureClass, type LiveStream } from "./Viewport";

const still = (app: string, state: string): string => new URL(`../../../../../main/server/computer/fixtures/apps/${app}/${state}/window.jpg`, import.meta.url).href;
const PAGE = { width: 1200, height: 800 };
const noop = (): void => {};

export const streamOf = (state: PreviewState, mode: LiveStream["mode"] = "video"): LiveStream => ({ state, retry: noop, canvas: { current: null }, ring: { current: null }, mode });
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
  ...over,
});

export interface FullViewFixture {
  name: string;
  props: FullViewProps;
}

const page = <img src={still("finder", "folder")} alt="" draggable={false} className={pictureClass(true)} />;
// the room a small window gives the lightbox; the picture's own pixels at 2× are 600 by 400
const ROOM = { width: 820, height: 560 };
const base = { all: [], room: ROOM, name: "Live view of Expense report in Chromium", dpr: 2 } as const;

const fixtures: FullViewFixture[] = [
  { name: "The agent drives the box's browser: the picture at its own pixels", props: { ...base, tile: tile(), stream: streamOf(live()), picture: page } },
  { name: "He drives: the row says so, and offers Hand back alone", props: { ...base, tile: tile({ driving: true, doing: null }), stream: streamOf(live()), picture: page } },
  { name: "A window on a Mac: no driver to speak of, Stop alone", props: { ...base, tile: tile({ browser: false, title: "Tidy the Downloads folder", where: "Landon's MacBook" }), stream: streamOf(live(), "picture"), picture: page } },
  { name: "A narrow window: the picture scaled down whole, the row under it at its width", props: { ...base, room: { width: 420, height: 520 }, tile: tile(), stream: streamOf(live()), picture: page } },
  { name: "On its way: the skeleton in the picture's shape", props: { ...base, tile: tile(), stream: streamOf({ status: "starting", ...PAGE }) } },
  { name: "The stream ended and can be tried again", props: { ...base, tile: tile(), stream: streamOf({ status: "ended", reason: "error" }) } },
  { name: "Screen Recording is off", props: { ...base, tile: tile({ browser: false, title: "Tidy the Downloads folder" }), stream: streamOf({ status: "ended", reason: "permission" }, "picture") } },
  { name: "Nothing drives it any more", props: { ...base, tile: null, stream: streamOf({ status: "starting" }) } },
];

export default fixtures;
