// Every state of the Computers page, for `bun run ui:preview
// src/renderer/src/surfaces/ComputersView.preview.tsx#ComputersStates`
// and the dom test that keeps them honest. The pictures are the recorded app
// fixtures (src/main/server/computer/fixtures/apps): scratch content only.
import type { ReactNode } from "react";
import type { ComputerTile } from "../lib/computers";
import { stoppedPlate, type ComputersPageProps, type Place } from "./ComputersView";
import { drawnPixelated, fitStage, type PictureKind } from "../lib/stageLayout";
import { VM_STILL, tile } from "./threads/computer/FullWindow.fixtures";
import { PIXELATED, Viewport, ViewportLine, pictureClass, type PlateProps } from "./threads/computer/Viewport";
import type { VmState } from "../lib/winvmWake";

const still = (app: string, state: string): string => new URL(`../../../main/server/computer/fixtures/apps/${app}/${state}/window.jpg`, import.meta.url).href;
const noop = (): void => {};

const SHOTS: Record<string, { src: string; width: number; height: number }> = {
  vm: { src: VM_STILL, width: 1280, height: 800 },
  page: { src: still("finder", "folder"), width: 1200, height: 800 },
  doc: { src: still("textedit", "doc"), width: 1206, height: 1010 },
};

/** A still in the live picture's place, in the same box, sized as the place sizes the live one. */
export const shot = (name: keyof typeof SHOTS, label: string, kind: PictureKind = "window") => (place: Place): ReactNode => {
  const s = SHOTS[name];
  const fit = place.stage ? fitStage(place.room, s, 2, kind) : null;
  return (
    <div data-slot="computer-picture-room" style={fit ? { width: fit.width } : undefined} className={fit ? (drawnPixelated(fit.width, s, 2) ? PIXELATED : undefined) : "w-full"}>
      <Viewport fill face={{ kind: "live", drawn: true, picture: <img src={s.src} alt="" draggable={false} className={pictureClass(true)} /> }} label={label} size={s} />
    </div>
  );
};
const sized = (node: ReactNode) => (place: Place): ReactNode => {
  const fit = place.stage ? fitStage(place.room, null, 2) : null;
  return <div style={fit ? { width: fit.width } : undefined} className={fit ? undefined : "w-full"}>{node}</div>;
};
const elsewhere = (machine: string) => sized(<Viewport fill face={{ kind: "none" }} label={`Shown on ${machine} only`} line={<ViewportLine words={`Shown on ${machine} only`} />} />);
// The page's own stopped face (`stoppedPlate`): a plate with Retry, as every face of the stage.
const ended = () => sized(<Viewport fill face={{ kind: "plate", plate: stoppedPlate({ status: "ended", reason: "error" }, null, noop) }} label="Live view" />);
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
const vm = tile({
  id: "box\nvm:windows",
  title: "Windows VM",
  doing: null,
  driving: true,
  browser: false,
  pane: "vm:windows",
  computer: "vm:windows",
  entry: { ...tile().entry, previewKey: "vm:windows", row: { ...tile().entry.row, threadId: "vm:windows", computer: "vm:windows", driver: "owner", apps: [{ name: "Windows VM", bundleId: null, window: null }] } },
});
const stopped = tile({ id: "box\nt5", title: "Book the arena for Saturday", doing: "Filling in the booking form", pane: "t5", computer: "browser:t5" });

const pictures = new Map<string, (place: Place) => ReactNode>([
  [stopped.id, ended()],
  [browser.id, shot("page", "Live view of Expense report in Chromium")],
  [mac.id, shot("doc", "Live view of Untitled in TextEdit")],
  [driven.id, shot("page", "Live view of Parking in Chromium")],
  [asking.id, shot("doc", "Live view of Review in Frame.io")],
  [studio.id, elsewhere("Studio")],
  [vm.id, shot("vm", "Live view of Windows VM", "screen")],
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
  { name: "A Mac's window on the stage: its own shape, Stop alone", width: 1200, height: 860, props: { tiles: [{ ...mac, entry: { ...mac.entry, row: { ...mac.entry.row, lastCallAt: 40 } } }, browser], onOpenSession: noop, pictureOf } },
  { name: "He drives the page on the stage", width: 1200, height: 860, props: { tiles: [driven, mac], onOpenSession: noop, pictureOf } },
  { name: "He drives the Windows VM: its keys beside Hand back", width: 660, height: 520, props: { tiles: [vm], onOpenSession: noop, pictureOf } },
  { name: "One waits on him: it has the stage, its question in its caption", width: 1200, height: 860, props: { tiles: [browser, asking], onOpenSession: noop, pictureOf } },
  { name: "A narrow page: the strip under the stage", width: 520, height: 760, props: { tiles: [browser, mac, asking], onOpenSession: noop, pictureOf } },
  { name: "A pane 352 wide: the stage over a strip of one", width: 352, height: 640, props: { tiles: [browser, mac], onOpenSession: noop, pictureOf } },
  { name: "A picture that stopped, and can be tried again", width: 660, height: 500, props: { tiles: [stopped], onOpenSession: noop, pictureOf } },
  { name: "A first frame on its way", width: 660, height: 500, props: { tiles: [tile({ id: "box\nt9", computer: "browser:t9" })], onOpenSession: noop, pictureOf } },
  { name: "Nothing is being driven", width: 820, height: 400, props: { tiles: [], onOpenSession: noop, pictureOf } },
];

export default fixtures;

/** The VM's picture box with its plate over the desk it slept on, sized as the place sizes the live one. */
const plated = (plate: PlateProps) => (place: Place): ReactNode => {
  const fit = place.stage ? fitStage(place.room, SHOTS.vm, 2, "screen") : null;
  return (
    <div data-slot="computer-picture-room" style={fit ? { width: fit.width } : undefined} className={fit ? undefined : "w-full"}>
      <Viewport fill face={{ kind: "plate", plate }} label="Windows VM" size={SHOTS.vm} />
    </div>
  );
};
const vmAt = (state: VmState["state"], more: Partial<VmState> = {}): VmState => ({ state, cannot: null, error: null, display: { screen: "fit", detail: "sharp", canResize: true }, ...more });
const idleVm = tile({ ...vm, driving: false, idle: true, entry: { ...vm.entry, row: { ...vm.entry.row, driver: undefined, idle: true } } });
const threadVm = tile({ ...vm, title: "Travel budget for nationals", doing: "Typing in Excel", driving: false, idle: false, entry: { ...vm.entry, row: { ...vm.entry.row, threadId: "t7", driver: undefined } } });
const resting = (state: VmState): ComputerTile => tile({ ...idleVm, vm: state });
const vmShot = shot("vm", "Live view of Windows VM", "screen");
const one = (t: ComputerTile, picture: (place: Place) => ReactNode, more: Partial<ComputersPageProps> = {}): ComputersPageProps => ({ tiles: [t], onOpenSession: noop, pictureOf: (_t, place) => picture(place), vms: { box: t.vm ?? vmAt("awake") }, ...more });

/** One bar in every state (the prototypes' states.html and more.html). */
export const barStates: { name: string; props: ComputersPageProps }[] = [
  { name: "Asleep: the desk washed back, since when, and Wake after his own Sleep", props: one(resting(vmAt("asleep", { heldAsleep: true })), plated({ title: "Asleep", detail: "Since 1:14 PM", still: VM_STILL })) },
  { name: "Waking, counted against the usual wake", props: one(resting(vmAt("waking")), plated({ title: "Waking the Windows VM", detail: "6 s of about 13", spin: true, still: VM_STILL })) },
  { name: "Connecting: the last picture under a lighter wash", props: one(idleVm, plated({ title: "Connecting", spin: true, still: VM_STILL, light: true })) },
  { name: "Idle: the delay a quiet number, Take over the one press", props: one(idleVm, vmShot, { reading: { delayMs: 31, fps: 60, picture: { width: 2912, height: 1868, scale: 2 }, link: "good" } }) },
  { name: "A thread drives: its title leads and goes to the thread", props: one(threadVm, vmShot, { reading: { delayMs: 33, fps: 58, link: "good" } }) },
  { name: "He drives: Keys, the menu, Hand back with its key cap", props: one(vm, vmShot, { reading: { delayMs: 31, fps: 60, link: "good" } }) },
  { name: "Link poor: the number gives way to two words", props: one(vm, vmShot, { reading: { delayMs: 212, fps: 22, link: "poor" } }) },
  { name: "Lost: the last picture washed back while the page tries again", props: one(idleVm, plated({ title: "Reconnecting to The box", detail: "Try 2 of 5", spin: true, still: VM_STILL })) },
  { name: "Not set up: the plate on the bare box, one press to Settings", props: one(resting(vmAt("none")), plated({ title: "The Windows VM is not set up" })) },
  { name: "The box's page on the stage: Take over, no VM menu", props: { tiles: [browser, mac], onOpenSession: noop, pictureOf, reading: { delayMs: 28, fps: 60, link: "good" } } },
  { name: "A Mac's window on the stage: Stop alone, in its own shape", props: { tiles: [{ ...mac, entry: { ...mac.entry, row: { ...mac.entry.row, lastCallAt: 40 } } }], onOpenSession: noop, pictureOf } },
  { name: "Nothing driven: the header says the page's name", props: { tiles: [], onOpenSession: noop } },
];
