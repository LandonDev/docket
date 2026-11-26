import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { WinvmPoint, WinvmState } from "@server/shared/contract-work-winvm";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Kbd } from "@renderer/components/ui/kbd";
import { StatusMark } from "@renderer/components/ui/status";
import { loadToast } from "@renderer/components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { Tip, TruncateTip } from "@renderer/components/tip";
import { cn } from "@renderer/lib/cn";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { Desktop, Globe, Keyboard, Laptop, LogIn, Moon, MoreHorizontal, RefreshCw, RotateCcw, Settings, Square } from "../../../chrome/icons";
import { LazyPopover, RowsMenu, type MenuRow } from "../../../chrome/menuRows";
import { pressKeys } from "../../../lib/computerVideo";
import { canTakeOver, handBack, takeOver, type ComputerTile } from "../../../lib/computers";
import { stopComputer } from "../../../lib/computerSessions";
import { registry } from "../../../lib/connection/registry";
import { hostFailure } from "../../../lib/hostFailure";
import { nameInLine } from "../../../lib/hostWords";
import { keyHint } from "../../../lib/keys";
import { useLinkMay } from "../../../lib/linkMay";
import { workErrorWords } from "../../../lib/workErrorWords";
import { LEAVE_CHORD } from "../../../lib/video/videoInput";
import { VM_SCREEN_PICKS, wakeVm, type VmDetail, type VmScreenPick, type VmState } from "../../../lib/winvmWake";
import { requestSettings } from "../../../lib/monaco/debugTab";
import { PointsDialog } from "../../settings/computers/Winvm";
import { signInOnVm } from "../../../work/winvm/signIn";
import { restartVm, setVmScreen, sleepVm } from "../../../work/winvm/vmPresses";

/**
 * The computer's bar (docs/DESIGN.md "Computers", "The bar"): one 40px row
 * that says whose computer it is and holds every press it has. On the
 * Computers page it is the page's header; in full screen it floats over the
 * top edge; in the pop-out it is the window's handle. In order: the glyph,
 * the title (a press goes to the thread that drives it), one muted status
 * sentence, then the delay (a quiet number that opens), Keys while he drives
 * the Windows VM, the VM's menu, Take over or Hand back, Stop, and the views
 * (Pop out, Full screen). Under 640px the delay and Pop out give way, whole;
 * under 480px the status sentence too, and under 400px Full screen (a click on
 * the picture opens it), so the title reads whole.
 */

/** What a computer says first: that he drives, a card's question, else the step's words. */
export const tileLine = (tile: ComputerTile): string | null => (tile.driving ? "You are driving" : (tile.entry.row.asking?.line ?? tile.doing));

/** Why the bar has no Take over on a VM that shows only its 4 fps picture. */
export const NO_LIVE_PICTURE = "No live picture to drive";

/**
 * The delay's numbers, as the stream measures them (a ping the relay answers, the worker's arrival to draw): each
 * left out until it is known. With no `delayMs` the delay is not drawn at all.
 */
export interface BarReading {
  delayMs?: number;
  fps?: number;
  picture?: { width: number; height: number; scale?: number };
  link?: "good" | "poor";
}

/** The VM's Size and Detail, as the bar's menu reads and sets them: the host's choice and the press that changes it. */
export interface VmScreenSeam {
  screen: VmScreenPick | null;
  detail: VmDetail | null;
  /** Windows takes a new size now (live resize); else the rows are off with `reason` as their line */
  canResize: boolean;
  onPick: (pick: { screen: VmScreenPick } | { detail: VmDetail }) => void;
}

/** The menu's Size rows. */
const SIZE_WORDS: Record<VmScreenPick, string> = { fit: "Fit to window", "1280x800": "1280 × 800", "1920x1200": "1920 × 1200", "2560x1600": "2560 × 1600" };
/** Why Size and Detail are off. */
export const NO_RESIZE = "Set Screen size to Fits my window in Settings, Windows VM";
export const THREAD_HOLDS = "A thread is using it";

/** The glyph a computer wears: the Windows VM's screen, the box's page, a Mac's or a PC's window. */
export const glyphOf = (tile: Pick<ComputerTile, "computer" | "browser"> | null): "screen" | "page" | "window" => (!tile || tile.computer.startsWith("vm:") ? "screen" : tile.browser ? "page" : "window");
const GLYPHS = { screen: Desktop, page: Globe, window: Laptop } as const;
function Glyph({ tile }: { tile: ComputerTile | null }) {
  const kind = glyphOf(tile);
  const Icon = GLYPHS[kind];
  return (
    <span data-glyph={kind} className="flex shrink-0 text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

/**
 * A quiet icon button with a tip, for the bar's views (Pop out, Full screen, back, close). `fold`: it gives way under
 * 640px; `"last"`: under 400px, the press that goes last (Full screen, which a click on the picture also opens).
 */
export function ViewButton({ label, onClick, children, fold = false }: { label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void; children: ReactNode; fold?: boolean | "last" }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={cn("text-muted-foreground hover:text-foreground", fold === "last" ? FOLD_LAST : fold && FOLD)} aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** What gives way first on a narrow bar: the delay and Pop out, whole. */
export const FOLD = "@max-[640px]/bar:hidden";
/** The title keeps half the row beside the sentence; once the sentence gives way (under 480px) it has the row. */
const TITLE_ROOM = "@max-[480px]/bar:max-w-full @max-[480px]/bar:shrink";
/** What gives way last, under 400px of bar: Full screen, so the title reads whole beside Take over and Stop. */
export const FOLD_LAST = "@max-[400px]/bar:hidden";

/** The press runner every control of the bar shares: one at a time, a failure as a toast naming the computer. */
function usePress(title: string) {
  const [busy, setBusy] = useState<string | null>(null);
  const pressing = useRef(false);
  const press = (which: string, run: () => Promise<unknown>, failed: string): void => {
    if (pressing.current) return;
    pressing.current = true;
    setBusy(which);
    void run()
      // The toast's two lines, as every failed act's: what failed, then the computer and why in Work's words, never the
      // host's raw text (a path, a method, a stack), which leaves the computer's name alone.
      .catch((err: unknown) => {
        const why = workErrorWords(err);
        return loadToast().then((toast) => toast.error(failed, { description: why ? `${title}: ${why}` : title }));
      })
      .finally(() => {
        pressing.current = false;
        setBusy(null);
      });
  };
  return { busy, press };
}

/**
 * Take over (where the computer takes input from its picture) and Stop; while he drives, Hand back alone, the one
 * primary, with the chord that leaves the picture as a key cap (gone under 400px of bar). `onTookOver` runs as the press begins, so the picture
 * can take the keyboard as soon as it is his.
 */
export function StageControls({ tile, onTookOver, small = false }: { tile: ComputerTile; onTookOver?: () => void; small?: boolean }) {
  const { busy, press } = usePress(tile.title);
  if (tile.driving)
    return (
      <Button size={small ? "xs" : "sm"} data-hand-back disabled={!!busy} onClick={() => press("back", () => handBack(tile), "Couldn't hand it back")}>
        <BusyLabel busy={busy === "back"} label="Hand back" />
        {small ? null : (
          // Under 400px of bar the key cap goes first, so the computer's name reads beside Hand back.
          <Kbd size="sm" aria-hidden="true" className={cn("border-transparent bg-transparent text-primary-foreground", FOLD_LAST)}>
            {keyHint(LEAVE_CHORD)}
          </Kbd>
        )}
      </Button>
    );
  return (
    <>
      {canTakeOver(tile) ? (
        <Button
          variant="secondary"
          size={small ? "xs" : "sm"}
          disabled={!!busy}
          onClick={() =>
            press(
              "take",
              async () => {
                onTookOver?.();
                await takeOver(tile);
              },
              "Couldn't take over",
            )
          }
        >
          <BusyLabel busy={busy === "take"} label="Take over" />
        </Button>
      ) : null}
      {/* an idle page has nothing running to stop */}
      {tile.idle ? null : (
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label={`Stop ${tile.title}`} disabled={!!busy} onClick={() => press("stop", () => stopComputer(tile.entry), "Couldn't stop it")} />}
          >
            <Square className="size-2.5 fill-current" />
          </TooltipTrigger>
          <TooltipContent>Stop</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

/** The keys a person's own keyboard cannot send into the Windows VM from here, by HID usage code: pressed in order, let go in reverse. */
export const VM_KEYS: readonly { id: string; label: string; keys: readonly number[] }[] = [
  { id: "windows", label: "Windows key", keys: [227] },
  { id: "ctrl-alt-del", label: "Ctrl+Alt+Del", keys: [224, 226, 76] },
  { id: "alt-tab", label: "Alt+Tab", keys: [226, 43] },
];

/** The picture he drives nearest to an element of its bar: the stage's, full screen's, the pop-out's. */
export function pictureNear(el: Element | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const picture = n.querySelector<HTMLElement>('[role="application"]');
    if (picture) return picture;
  }
  return null;
}

/**
 * While he drives the Windows VM: one quiet button with the keys his own keyboard would keep for itself. A pick gives
 * the keyboard back to the picture, so the next keys he types go to the VM (Start opened by the Windows key takes them).
 */
function KeysMenu({ tile, onOpenChange }: { tile: ComputerTile; onOpenChange?: (open: boolean) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const back = { get current() { return pictureNear(button.current) ?? button.current; } };
  return (
    <RowsMenu
      finalFocus={back}
      label="Keys"
      align="end"
      tip={{ label: "Keys" }}
      onOpenChange={onOpenChange}
      rows={VM_KEYS.map((k) => ({ kind: "item" as const, id: k.id, label: k.label }))}
      onPick={(id) => {
        const chord = VM_KEYS.find((k) => k.id === id);
        if (!chord || !tile.entry.previewHost || !tile.entry.previewKey) return;
        void pressKeys(tile.entry.previewHost, tile.entry.previewKey, chord.keys).then((sent) => {
          if (!sent) void loadToast().then((toast) => toast.error("Couldn't send the keys", { description: tile.title }));
        });
      }}
      trigger={
        <Button ref={button} variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="Keys">
          <Keyboard className="size-4" />
        </Button>
      }
    />
  );
}

/** The delay as the bar says it: the number, or "Link poor" in its place. */
export const delayWords = (reading: BarReading): string => (reading.link === "poor" ? "Link poor" : `${Math.round(reading.delayMs ?? 0)} ms`);

/**
 * The delay: a quiet number that opens to what it is made of. Drawn only once the stream has a number; on a poor link
 * the number gives way to "Link poor", and opened it says why and offers Faster where the computer has it.
 */
export function DelayButton({ reading, onFaster, onOpenChange }: { reading: BarReading; onFaster?: () => void; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  if (reading.delayMs === undefined) return null;
  const poor = reading.link === "poor";
  const rows: [string, string][] = [["Delay", `${Math.round(reading.delayMs)} ms`]];
  if (reading.fps !== undefined) rows.push(["Frames", `${Math.round(reading.fps)} a second`]);
  if (reading.picture) rows.push(["Picture", `${reading.picture.width} × ${reading.picture.height}${reading.picture.scale && reading.picture.scale !== 1 ? `, ${Math.round(reading.picture.scale * 100)}%` : ""}`]);
  if (reading.link === "good") rows.push(["Link", "Good"]);
  return (
    <LazyPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
      align="end"
      label="Delay"
      className="w-62 gap-0 p-3"
      trigger={
        <Button variant="ghost" size="sm" data-slot="computer-delay" aria-label={poor ? "Link poor, details" : `Delay ${Math.round(reading.delayMs)} ms, details`} className={cn("px-2 text-xs tabular-nums", poor ? "text-foreground" : "text-muted-foreground hover:text-foreground", FOLD)}>
          {delayWords(reading)}
        </Button>
      }
    >
      {poor ? (
        <div className="mb-2 flex flex-col gap-1">
          <span className="text-[13px] leading-5 font-medium">The link is slow</span>
          <span className="text-xs leading-4 text-muted-foreground">Frames reach this computer late.{onFaster ? " Faster reduces the picture size." : ""}</span>
        </div>
      ) : null}
      <dl className="m-0 flex flex-col text-[13px]">
        {rows.map(([name, value]) => (
          <div key={name} className="flex h-6 items-center justify-between gap-6">
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="m-0 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {poor && onFaster ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2 w-full"
          onClick={() => {
            onFaster();
            setOpen(false);
          }}
        >
          Use Faster
        </Button>
      ) : null}
    </LazyPopover>
  );
}

/** The Windows VM's Size and Detail as the host says them, and the press that sets them (`work.winvm.settings`). */
export function vmScreenSeam(host: string, vm: VmState | undefined): VmScreenSeam | null {
  const display = vm?.display;
  if (!display) return null;
  return {
    screen: display.screen,
    detail: display.detail,
    canResize: display.canResize,
    onPick: (pick) =>
      void setVmScreen(host, pick).catch((err: unknown) => loadToast().then((toast) => toast.error(hostFailure(host, err, "did not change the Windows VM's screen", true)))),
  };
}

export interface VmMenuProps {
  host: string;
  /** the machine's state: awake, asleep… */
  state: VmState["state"];
  /** a thread holds it now: Size, Detail and Restart wait for it */
  held: boolean;
  /** Size and Detail; null where the host does not say them */
  screen: VmScreenSeam | null;
  onOpenChange?: (open: boolean) => void;
}

/** The menu's rows, pure: what the machine itself can do, with what this window's key may not left out. */
export function vmMenuRows({ state, held, screen, may }: Pick<VmMenuProps, "state" | "held" | "screen"> & { may: { admin: boolean; operate: boolean } }): MenuRow[] {
  const rows: MenuRow[] = [];
  if (screen && may.admin) {
    const off = !screen.canResize ? NO_RESIZE : held ? THREAD_HOLDS : null;
    rows.push({ kind: "label", label: "Size" });
    for (const pick of VM_SCREEN_PICKS) rows.push({ kind: "item", id: `screen:${pick}`, label: SIZE_WORDS[pick], checked: screen.screen === pick, ...(off ? { disabled: true, reason: off } : {}) });
    rows.push({ kind: "sep" }, { kind: "label", label: "Detail" });
    for (const detail of ["sharp", "faster"] as const) rows.push({ kind: "item", id: `detail:${detail}`, label: detail === "sharp" ? "Sharp" : "Faster", checked: screen.detail === detail, ...(off ? { disabled: true, reason: off } : {}) });
    // Off for want of live resize: the one press that turns it on, Screen size on the Windows VM's page.
    if (!screen.canResize) rows.push({ kind: "item", id: "screen-settings", label: "Open Settings", icon: Settings });
    rows.push({ kind: "sep" });
  }
  if (may.operate) {
    if (state === "awake") rows.push({ kind: "item", id: "sleep", label: "Sleep", icon: Moon }, { kind: "item", id: "restart", label: "Restart Windows…", icon: RefreshCw, ...(held ? { disabled: true, reason: THREAD_HOLDS } : {}) });
    rows.push({ kind: "item", id: "sign-in", label: "Sign in to Office and OneDrive…", icon: LogIn });
  }
  rows.push({ kind: "item", id: "points", label: "Restore points…", icon: RotateCcw });
  return rows;
}

/** One menu for what the Windows VM itself can do: Size, Detail, Sleep or Wake, Restart, the sign-in and the restore points. */
export function VmMenu({ host, state, held, screen, onOpenChange }: VmMenuProps) {
  const admin = useLinkMay(host, "work.winvm.settings");
  const operate = useLinkMay(host, "work.winvm.wake");
  const [points, setPoints] = useState(false);
  const rows = vmMenuRows({ state, held, screen, may: { admin, operate } });
  const fail = (act: string) => (err: unknown) => void loadToast().then((toast) => toast.error(hostFailure(host, err, act, true)));
  return (
    <>
      <RowsMenu
        label="Windows VM"
        align="end"
        tip={{ label: "Size, sleep and more" }}
        onOpenChange={onOpenChange}
        rows={rows}
        onPick={(id) => {
          if (id === "screen-settings") return requestSettings("winvm", "winvm.screen");
          if (id.startsWith("screen:")) return screen?.onPick({ screen: id.slice(7) as VmScreenPick });
          if (id.startsWith("detail:")) return screen?.onPick({ detail: id.slice(7) as VmDetail });
          if (id === "sleep") return void sleepVm(host).catch(fail("did not put the Windows VM to sleep"));
          if (id === "restart")
            return void confirmAction({ title: "Restart Windows?", body: "Save your work in it first. Sign-ins stay.", action: "Restart" }).then(
              (ok) => ok && restartVm(host).catch(fail("did not restart Windows")),
            );
          if (id === "sign-in") return void signInOnVm(host).catch(fail("did not bring up the sign-in"));
          if (id === "points") setPoints(true);
        }}
        trigger={
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="Windows VM">
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      {points ? <VmPoints host={host} onClose={() => setPoints(false)} /> : null}
    </>
  );
}

/** The restore points' dialog from the bar: Settings' own, over the points read from the host and kept current. */
function VmPoints({ host, onClose }: { host: string; onClose: () => void }) {
  const link = useMemo(() => registry.linkOf(host), [host]);
  const admin = useLinkMay(host, "work.winvm.settings");
  const [state, setState] = useState<WinvmState | null>(null);
  const [points, setPoints] = useState<WinvmPoint[]>([]);
  useEffect(() => {
    void link.request<WinvmState>("work.winvm.state", {}).then(setState, () => onClose());
    void link.request<{ points: WinvmPoint[] }>("work.winvm.points", {}).then((p) => setPoints(p.points), () => undefined);
    return link.onPush((push) => {
      if (push.push === "work.winvm") setState(push.state as WinvmState);
      if (push.push === "work.winvm.points") setPoints(push.points as WinvmPoint[]);
    });
  }, [link, onClose]);
  return state ? <PointsDialog env={host} state={state} points={points} admin={admin} onClose={onClose} /> : null;
}

/**
 * The status sentence's facts, in order: the step's own words (or "You are driving", or a card's question), "No live
 * picture to drive" on a VM with only its 4 fps picture, then where it runs, lower case in the middle of the line
 * (`nameInLine`). A card's question goes without the place: a question mark and a comma do not meet, and the strip and
 * the thread say where.
 */
export function barSentence(tile: ComputerTile | null, where?: string | null): string[] {
  if (!tile) return [];
  const line = tileLine(tile);
  const asking = !!tile.entry.row.asking && !tile.driving;
  const place = asking ? null : where === undefined ? tile.where : where;
  const lead = [line, tile.pictureOnly && !tile.driving ? NO_LIVE_PICTURE : null].filter((w): w is string => !!w);
  return place ? [...lead, lead.length ? nameInLine(place) : place] : lead;
}

/**
 * The sentence on one 16px line: only the first fact cuts, at its end; a fact that does not fit after it drops whole to
 * a second line the box hides, its comma with it (the comma leads each later fact, so none is left hanging). Whatever
 * gave way reads in the line's tip. It gives way whole under 480px of bar, so the title reads whole.
 */
function BarSentence({ parts, words }: { parts: ReactNode[]; words: string[] }) {
  const [el, ref] = useState<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);
  const whole = words.join(", ");
  useLayoutEffect(() => {
    if (!el) return;
    const first = el.firstElementChild as HTMLElement | null;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1 || (!!first && first.scrollWidth > first.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, whole]);
  if (!parts.length) return null;
  const line = (
    <span ref={ref} data-slot="facts" data-bar-sentence className="flex h-4 min-w-0 flex-1 flex-wrap overflow-hidden text-xs leading-4 whitespace-nowrap text-muted-foreground tabular-nums @max-[480px]/bar:hidden">
      {parts.map((part, i) => (
        <span key={`${i}:${words[i]}`} className={i === 0 ? "min-w-0 truncate" : "shrink-0 before:me-1 before:content-[',']"}>
          {part}
        </span>
      ))}
    </span>
  );
  return cut ? <Tip label={whole}>{line}</Tip> : line;
}

export interface ComputerBarProps {
  /** null: the computer left (full screen and the pop-out keep their bar for the way out) */
  tile: ComputerTile | null;
  /** The stage is showing Lost or Reconnecting. */
  linkLost?: boolean;
  /** the name to show with no tile */
  name?: string;
  /** a press on the title: the thread */
  onOpenSession?: (threadId: string, host: string) => void;
  onTookOver?: () => void;
  /** where it runs, or null where the picture already names the machine */
  where?: string | null;
  /** the delay's numbers, as far as they are known */
  reading?: BarReading | null;
  /** Faster, offered from a poor link's delay */
  onFaster?: () => void;
  /** the VM's state on its host: its menu; none for a computer that is not the Windows VM, or in the pop-out */
  vm?: VmState | null;
  screen?: VmScreenSeam | null;
  /** in place of Take over: the press a computer that is not set up has */
  action?: ReactNode;
  /** the views at its end: Pop out and Full screen, Leave full screen, Back to the page and Close */
  views?: ReactNode;
  /** a menu or the delay opened or closed: a floating bar stays while one is open */
  onMenuOpen?: (open: boolean) => void;
  /** the pop-out's smaller controls */
  small?: boolean;
  /** it gives way by its own width (the page, the pop-out); afloat it is narrow by design and keeps every part */
  fold?: boolean;
  className?: string;
}

/**
 * The bar, pure. Its title leads (13px medium), the status sentence follows it on the same line (12px muted, the
 * driving words and a card's question in foreground), and every press sits at its end, always shown.
 */
export function ComputerBar({ tile, linkLost = false, name, onOpenSession, onTookOver, where, reading, onFaster, vm, screen = null, action, views, onMenuOpen, small = false, fold = true, className }: ComputerBarProps) {
  const line = tile ? tileLine(tile) : null;
  const asking = !!tile?.entry.row.asking && !tile.driving;
  const thread = tile && !tile.entry.row.threadId.startsWith("vm:") ? tile.entry.row.threadId : null;
  const title = tile?.title ?? name ?? "";
  const vmHere = !!tile?.computer.startsWith("vm:");
  const state = vm?.state ?? (vmHere ? "awake" : null);
  const words = barSentence(tile, where);
  const parts: ReactNode[] = words.map((w, i) => (i === 0 && line && w === line && (tile?.driving || asking) ? <span className="text-foreground">{w}</span> : w));
  return (
    <div data-slot="computer-bar" className={cn(fold && "@container/bar", "flex h-10 min-w-0 flex-1 items-center gap-1 ps-3 pe-2", className)}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Glyph tile={tile} />
        <TruncateTip text={title}>
          {thread && onOpenSession ? (
            <Button variant="link" size="xs" className={cn("h-6 max-w-[50%] shrink-0 justify-start p-0 leading-5 font-medium text-foreground", TITLE_ROOM, small ? "text-xs" : "text-[13px]")} onClick={() => onOpenSession(thread, tile!.entry.host)}>
              <span className="truncate">{title}</span>
            </Button>
          ) : (
            <span className={cn("max-w-[50%] shrink-0 truncate leading-5 font-medium", TITLE_ROOM, small ? "text-xs" : "text-[13px]")}>{title}</span>
          )}
        </TruncateTip>
        {asking && line && !small ? (
          // Under 480px the sentence gives way to the title; the card's question keeps its mark there, whole in its tip.
          <Tip label={line}>
            <span tabIndex={0} role="img" aria-label={line} data-bar-asking className="focus-ring hidden shrink-0 rounded-sm @max-[480px]/bar:inline-flex">
              <StatusMark state="waiting" word={false} />
            </span>
          </Tip>
        ) : null}
        {small ? null : <BarSentence parts={parts} words={words} />}
      </div>
      <span data-slot="computer-reads" className="flex shrink-0 items-center gap-0.5">
        {reading ? <DelayButton reading={reading} onFaster={linkLost ? undefined : onFaster} onOpenChange={onMenuOpen} /> : null}
        {!linkLost && tile?.driving && vmHere ? <KeysMenu tile={tile} onOpenChange={onMenuOpen} /> : null}
        {!linkLost && vm && tile && state && state !== "none" && state !== "setting-up" && !small ? (
          <VmMenu host={tile.entry.host} state={state} held={!!thread && !tile.driving} screen={screen} onOpenChange={onMenuOpen} />
        ) : null}
      </span>
      {tile && (action || (!linkLost && vm?.state !== "none")) ? (
        <span data-slot="computer-controls" className="ms-2 flex shrink-0 items-center gap-1">
          {action ?? <StageControls tile={tile} onTookOver={onTookOver} small={small} />}
        </span>
      ) : null}
      {views ? <span className="ms-2 flex shrink-0 items-center gap-0.5">{views}</span> : null}
    </div>
  );
}

/** Wake, for a VM he put to sleep himself: the page waits for this press rather than waking it. */
export function WakeButton({ host }: { host: string }) {
  const { busy, press } = usePress("Windows VM");
  return (
    <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => press("wake", () => wakeVm(host), "Couldn't wake the Windows VM")}>
      <BusyLabel busy={!!busy} label="Wake" />
    </Button>
  );
}

/** Settings, Windows VM, where a VM that is not set up is set up: the bar's one press for it. */
export function OpenSettingsButton() {
  return (
    <Button variant="secondary" size="sm" onClick={() => requestSettings("winvm")}>
      Open Settings
    </Button>
  );
}
