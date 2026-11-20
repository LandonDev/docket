// Every state of the Computers page, for `bun run ui:preview
// src/renderer/src/surfaces/ComputersView.preview.tsx#ComputersStates`
// and the dom test that keeps them honest. The pictures are the recorded app
// fixtures (src/main/server/computer/fixtures/apps): scratch content only.
import type { ReactNode } from "react";
import type { ComputerTile } from "../lib/computers";
import type { ComputersPageProps, Place } from "./ComputersView";
import { fitStage } from "../lib/stageLayout";
import { tile } from "./threads/computer/FullWindow.fixtures";
import { Viewport, ViewportLine, pictureClass } from "./threads/computer/Viewport";

const still = (app: string, state: string): string => new URL(`../../../main/server/computer/fixtures/apps/${app}/${state}/window.jpg`, import.meta.url).href;
const noop = (): void => {};

const SHOTS: Record<string, { src: string; width: number; height: number }> = {
  page: { src: still("finder", "folder"), width: 1200, height: 800 },
  doc: { src: still("textedit", "doc"), width: 1206, height: 1010 },
};

/** A still in the live picture's place, in the same box, sized as the place sizes the live one. */
const shot = (name: keyof typeof SHOTS, label: string) => (place: Place): ReactNode => {
  const s = SHOTS[name];
  const fit = place.stage ? fitStage(place.room, s, 2) : null;
  return (
    <div style={fit ? { width: fit.width } : undefined} className={fit ? undefined : "w-full"}>
      <Viewport fill face={{ kind: "live", drawn: true, picture: <img src={s.src} alt="" draggable={false} className={pictureClass(true)} /> }} label={label} size={s} />
    </div>
  );
};
const sized = (node: ReactNode) => (place: Place): ReactNode => {
  const fit = place.stage ? fitStage(place.room, null, 2) : null;
  return <div style={fit ? { width: fit.width } : undefined} className={fit ? undefined : "w-full"}>{node}</div>;
};
const elsewhere = (machine: string) => sized(<Viewport fill face={{ kind: "none" }} label={`Shown on ${machine} only`} line={<ViewportLine words={`Shown on ${machine} only`} />} />);
const ended = () => sized(<Viewport fill face={{ kind: "none" }} label="Live view" line={<ViewportLine words="The preview stopped" onRetry={noop} />} />);
const coming = sized(<Viewport fill face={{ kind: "skeleton" }} label="Live view" size={{ width: 1280, height: 800 }} />);

const browser = tile({ entry: { ...tile().entry, row: { ...tile().entry.row, lastCallAt: 30 } } });
const mac = tile({ id: "local\nt2", title: "Tidy the Downloads folder", doing: "Reading Finder", where: "Landon's MacBook", browser: false, pane: "t2", computer: "window:t2" });
const driven = tile({ id: "box\nt3", title: "Renew the parking permit", doing: null, driving: true, pane: "t3", computer: "browser:t3" });
const studio = tile({ id: "box\nt4", title: "Export the March invoices from the accounting app", doing: "Clicking Export in Numbers", where: "Studio", browser: false, shownOn: "Studio", pane: "t4", computer: "window:t4" });
const asking = tile({
  id: "local\nt6",
  title: "Trailer review round 3",
  doing: null,
  where: "Landon's MacBook",
  browser: false,
  pane: "t6",
  computer: "window:t6",
  entry: { ...tile().entry, host: "local", row: { ...tile().entry.row, threadId: "t6", lastCallAt: 2, asking: { line: "Allow Frame.io to be used?" } } },
});
const stopped = tile({ id: "box\nt5", title: "Book the arena for Saturday", doing: "Filling in the booking form", pane: "t5", computer: "browser:t5" });

const pictures = new Map<string, (place: Place) => ReactNode>([
  [stopped.id, ended()],
  [browser.id, shot("page", "Live view of Expense report in Chromium")],
  [mac.id, shot("doc", "Live view of Untitled in TextEdit")],
  [driven.id, shot("page", "Live view of Parking in Chromium")],
  [asking.id, shot("doc", "Live view of Review in Frame.io")],
  [studio.id, elsewhere("Studio")],
]);
const pictureOf = (t: ComputerTile, place: Place): ReactNode => (pictures.get(t.id) ?? coming)(place);

export interface ComputersFixture {
  name: string;
  /** the page's body: the window less the rail and the 40px header */
  width: number;
  height: number;
  props: ComputersPageProps;
}

const fixtures: ComputersFixture[] = [
  { name: "One computer has the page (1440×900)", width: 1200, height: 860, props: { tiles: [browser], onOpenSession: noop, pictureOf } },
  { name: "Three: the stage and a strip beside it (1440×900)", width: 1200, height: 860, props: { tiles: [browser, mac, studio], onOpenSession: noop, pictureOf } },
  { name: "Three in a smaller window (900×700)", width: 660, height: 660, props: { tiles: [browser, mac, studio], onOpenSession: noop, pictureOf } },
  { name: "He drives the page on the stage", width: 1200, height: 860, props: { tiles: [driven, mac], onOpenSession: noop, pictureOf } },
  { name: "One waits on him: it has the stage, its question in its caption", width: 1200, height: 860, props: { tiles: [browser, asking], onOpenSession: noop, pictureOf } },
  { name: "A narrow page: the strip under the stage", width: 520, height: 760, props: { tiles: [browser, mac, asking], onOpenSession: noop, pictureOf } },
  { name: "A picture that stopped, and can be tried again", width: 660, height: 500, props: { tiles: [stopped], onOpenSession: noop, pictureOf } },
  { name: "A first frame on its way", width: 660, height: 500, props: { tiles: [tile({ id: "box\nt9", computer: "browser:t9" })], onOpenSession: noop, pictureOf } },
  { name: "Nothing is being driven", width: 820, height: 400, props: { tiles: [], onOpenSession: noop, pictureOf } },
];

export default fixtures;
