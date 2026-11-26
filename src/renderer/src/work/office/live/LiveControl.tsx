import { useEffect, useRef, useState } from "react";
import type { OfficeLiveOf } from "@shared/contract-work-office";
import { ChevronDown } from "../../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../../chrome/menuRows";
import { Button } from "../../../components/ui/button";
import { APP_NAME, liveLabel, type LiveApp, type LiveMode } from "./liveSwitch";

/** A computer a desktop app opens the file on, as he names it ("MacBook", "the Windows VM"). */
export interface LiveDesktop {
  name: string;
  open(): void;
}

/**
 * The header's one control on a shared Office file (docs/DESIGN.md "The Files place"): a menu button named by the
 * mode the tab is in, "Edit here" or "Word for the web" ("Here" and "Live" under 480px of header). Its menu holds the
 * two modes, then the desktop apps the file opens in, which act at once and leave the remembered mode as it is.
 * Absent on a file that cannot open live; until the host answers, its place is kept for the app the name implies,
 * so a late answer moves nothing.
 */
export function LiveControl({
  of,
  live,
  busy,
  desktops,
  onSwitch,
  onNoAddress,
  inTab = true,
  app = null,
}: {
  /** The host's answer for this tab (`work.office.live.of`); null until it comes. */
  of: OfficeLiveOf | null;
  /** The tab is drawn live now. */
  live: boolean;
  /** A switch is under way: the control waits. */
  busy: boolean;
  desktops: readonly LiveDesktop[];
  onSwitch(to: LiveMode): void;
  /** Live was chosen for a file with no web address: where he gives one. */
  onNoAddress(why: string): void;
  /** This window can draw Office for the web in the tab; a browser (/ui) opens the address in a tab of its own. */
  inTab?: boolean;
  /** The app the tab's file implies (`appOfName`, or the live item's): the control's place is kept for it until `of` comes. */
  app?: LiveApp | null;
}) {
  if (!of) return app ? <Keep live={live} app={app} /> : null;
  if (!of.app) return null;
  const rows = liveRows(of, live, desktops, inTab);
  return (
    <RowsMenu
      label="Open in"
      align="end"
      rows={rows}
      onPick={(id) => {
        if (id.startsWith("desktop:")) return desktops[Number(id.slice(8))]?.open();
        if (id === "web" && of.address) return void window.open(of.address, "_blank", "noopener");
        if (id === "here" && live) return onSwitch("here");
        if (id === "live" && !live) return of.address ? onSwitch("live") : onNoAddress(of.why ?? "This library has no web address yet.");
      }}
      trigger={
        // Named whole for a screen reader at every width: under 480px the eye reads "Here" or "Live".
        <Button variant="ghost" size="sm" disabled={busy} aria-label={live ? liveLabel(of.app) : "Edit here"} data-office-live-control className="shrink-0 gap-1 text-muted-foreground">
          <ModeLabel live={live} app={of.app} />
          <ChevronDown />
        </Button>
      }
    />
  );
}

/** The mode's name: whole from 480px of header (the file head's container), "Here" or "Live" under it, as Ask goes to its glyph. */
function ModeLabel({ live, app }: { live: boolean; app: LiveApp }) {
  return (
    <>
      <span className="@[480px]/file-head:hidden">{live ? "Live" : "Here"}</span>
      <span className="hidden @[480px]/file-head:inline">{live ? liveLabel(app) : "Edit here"}</span>
    </>
  );
}

/** The control's place while the host's answer is on its way: the same button, unseen and out of reach. */
function Keep({ live, app }: { live: boolean; app: LiveApp }) {
  return (
    <Button variant="ghost" size="sm" disabled aria-hidden tabIndex={-1} data-office-live-keep className="invisible shrink-0 gap-1">
      <ModeLabel live={live} app={app} />
      <ChevronDown />
    </Button>
  );
}

/** The menu: the two modes as ticked rows, then the desktop apps. A browser opens the web address in a tab of its own. */
export function liveRows(of: OfficeLiveOf, live: boolean, desktops: readonly Pick<LiveDesktop, "name">[], inTab: boolean): MenuRow[] {
  const app = of.app!;
  return [
    { kind: "item", id: "here", label: "Edit here", checked: !live },
    inTab
      ? { kind: "item", id: "live", label: of.address ? liveLabel(app) : `${liveLabel(app)}…`, checked: live }
      : { kind: "item", id: "web", label: `Open in ${liveLabel(app)}`, ...(of.address ? {} : { disabled: true, reason: of.why ?? "This library has no web address yet." }) },
    ...(desktops.length ? ([{ kind: "sep" }] satisfies MenuRow[]) : []),
    ...desktops.map((d, i): MenuRow => ({ kind: "item", id: `desktop:${i}`, label: `Open in ${APP_NAME[app]} ${d.name === "the Windows VM" ? "in" : "on"} ${d.name}` })),
  ];
}

/** How long a missed answer waits before it is asked again, step by step; past the last the timed asks stop. */
export const LIVE_OF_RETRY_MS = [2_000, 5_000, 15_000, 30_000] as const;

/**
 * The host's answer for a tab, asked again whenever the tab's item changes (a switch, a reseat). A miss keeps the last
 * answer and asks again after `LIVE_OF_RETRY_MS`, then no more by the clock (perf M11): a window focus or the link
 * opening again (`onOpen`) asks at once and starts the steps over, so one lost reply never hides the control for the
 * life of the tab, and a host that keeps refusing is not asked for ever.
 */
export function useLiveOf(ask: () => Promise<OfficeLiveOf>, itemId: string | null, onOpen?: (fn: () => void) => () => void): OfficeLiveOf | null {
  const [of, setOf] = useState<OfficeLiveOf | null>(null);
  // Bumped by a retry: the item and this count are what ask again.
  const [attempt, setAttempt] = useState(0);
  const missed = useRef(0);
  useEffect(() => {
    if (!itemId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let off: (() => void) | undefined;
    const again = (): void => {
      if (!live) return;
      live = false;
      setAttempt((n) => n + 1);
    };
    // A focus or a link that opens again: a fresh start of the steps.
    const woken = (): void => {
      if (!live) return;
      missed.current = 0;
      again();
    };
    ask().then(
      (answer) => {
        if (!live) return;
        missed.current = 0;
        setOf(answer);
      },
      () => {
        if (!live) return;
        if (missed.current < LIVE_OF_RETRY_MS.length) timer = setTimeout(again, LIVE_OF_RETRY_MS[missed.current]);
        missed.current += 1;
        off = onOpen?.(woken);
        window.addEventListener("focus", woken);
      },
    );
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off?.();
      window.removeEventListener("focus", woken);
    };
    // `ask` and `onOpen` are rebuilt each render; the tab's item and a retry are what change the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, attempt]);
  useEffect(() => {
    missed.current = 0;
  }, [itemId]);
  return of;
}
