// Every state of the Computers page, for `bun run ui:preview
// src/renderer/src/surfaces/ComputersView.preview.tsx#ComputersStates`
// and the dom test that keeps them honest. The pictures are the recorded app
// fixtures (src/main/server/computer/fixtures/apps): scratch content only.
import type { ReactNode } from "react";
import type { ComputerTile } from "../lib/computers";
import type { ComputersPageProps } from "./ComputersView";
import { tile } from "./threads/computer/LiveFullView.fixtures";
import { Viewport, ViewportLine, pictureClass } from "./threads/computer/Viewport";

const still = (app: string, state: string): string => new URL(`../../../main/server/computer/fixtures/apps/${app}/${state}/window.jpg`, import.meta.url).href;
const noop = (): void => {};

const SHOTS: Record<string, { src: string; width: number; height: number }> = {
  page: { src: still("finder", "folder"), width: 1200, height: 800 },
  doc: { src: still("textedit", "doc"), width: 1206, height: 1010 },
};

/** A still in the live picture's place, in the same box. */
const shot = (name: keyof typeof SHOTS, label: string): ReactNode => {
  const s = SHOTS[name];
  return <Viewport face={{ kind: "live", drawn: true, picture: <img src={s.src} alt="" draggable={false} className={pictureClass(true)} /> }} label={label} size={s} sharp={s.width / 2} />;
};
const elsewhere = (machine: string): ReactNode => <Viewport face={{ kind: "none" }} label={`Shown on ${machine} only`} line={<ViewportLine words={`Shown on ${machine} only`} />} />;
const coming = (): ReactNode => <Viewport face={{ kind: "skeleton" }} label="Live view" size={{ width: 1280, height: 800 }} sharp={640} />;

const browser = tile();
const mac = tile({ id: "local\nt2", title: "Tidy the Downloads folder", doing: "Reading Finder", where: "Landon's MacBook", browser: false, pane: "t2" });
const driven = tile({ id: "box\nt3", title: "Renew the parking permit", doing: null, driving: true, pane: "t3" });
const studio = tile({ id: "box\nt4", title: "Export the March invoices from the accounting app", doing: "Clicking Export in Numbers", where: "Studio", browser: false, shownOn: "Studio", pane: "t4" });

const pictures = new Map<string, ReactNode>([
  [browser.id, shot("page", "Live view of Expense report in Chromium")],
  [mac.id, shot("doc", "Live view of Untitled in TextEdit")],
  [driven.id, shot("page", "Live view of Parking in Chromium")],
  [studio.id, elsewhere("Studio")],
]);
const pictureOf = (t: ComputerTile): ReactNode => pictures.get(t.id) ?? coming();

export interface ComputersFixture {
  name: string;
  /** the page's width */
  width: number;
  props: ComputersPageProps;
}

const fixtures: ComputersFixture[] = [
  { name: "One computer: its picture at its own pixels", width: 820, props: { tiles: [browser], onOpenSession: noop, pictureOf } },
  { name: "Three, on a page two across: a browser the agent drives, a Mac's window, a page he drives", width: 820, props: { tiles: [browser, mac, driven], onOpenSession: noop, pictureOf } },
  { name: "A narrow page: one across, and one this desktop may not draw", width: 400, props: { tiles: [mac, studio], onOpenSession: noop, pictureOf } },
  { name: "A first frame on its way", width: 400, props: { tiles: [tile({ id: "box\nt9" })], onOpenSession: noop, pictureOf } },
  { name: "Nothing is being driven", width: 820, props: { tiles: [], onOpenSession: noop, pictureOf } },
];

export default fixtures;
