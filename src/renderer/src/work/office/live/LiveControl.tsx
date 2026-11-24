import { useEffect, useState } from "react";
import type { OfficeLiveOf } from "@shared/contract-work-office";
import { ChevronDown } from "../../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../../chrome/menuRows";
import { Button } from "../../../components/ui/button";
import { APP_NAME, liveLabel, type LiveMode } from "./liveSwitch";

/** A computer a desktop app opens the file on, as he names it ("MacBook", "the Windows VM"). */
export interface LiveDesktop {
  name: string;
  open(): void;
}

/**
 * The header's one control on a shared Office file (docs/DESIGN.md "The Files place"): a menu button named by the
 * mode the tab is in, "Edit here" or "Live in Word". Its menu holds the two modes, then the desktop apps the file
 * opens in, which act at once and leave the remembered mode as it is. Absent on a file that cannot open live.
 */
export function LiveControl({
  of,
  live,
  busy,
  desktops,
  onSwitch,
  onNoAddress,
  inTab = true,
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
}) {
  if (!of?.app) return null;
  const label = live ? liveLabel(of.app) : "Edit here";
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
        <Button variant="ghost" size="sm" disabled={busy} data-office-live-control className="shrink-0 gap-1 text-muted-foreground">
          {label}
          <ChevronDown />
        </Button>
      }
    />
  );
}

/** The menu: the two modes as ticked rows, then the desktop apps. A browser opens the web address in a tab of its own. */
export function liveRows(of: OfficeLiveOf, live: boolean, desktops: readonly Pick<LiveDesktop, "name">[], inTab: boolean): MenuRow[] {
  const app = of.app!;
  return [
    { kind: "item", id: "here", label: "Edit here", checked: !live },
    inTab
      ? { kind: "item", id: "live", label: of.address ? liveLabel(app) : `${liveLabel(app)}…`, checked: live }
      : { kind: "item", id: "web", label: `Open in ${APP_NAME[app]} on the Web`, ...(of.address ? {} : { disabled: true, reason: of.why ?? "This library has no web address yet." }) },
    ...(desktops.length ? ([{ kind: "sep" }] satisfies MenuRow[]) : []),
    ...desktops.map((d, i): MenuRow => ({ kind: "item", id: `desktop:${i}`, label: `Open in ${APP_NAME[app]} ${d.name === "the Windows VM" ? "in" : "on"} ${d.name}` })),
  ];
}

/** The host's answer for a tab, asked again whenever the tab's item changes (a switch, a reseat). */
export function useLiveOf(ask: () => Promise<OfficeLiveOf>, itemId: string | null): OfficeLiveOf | null {
  const [of, setOf] = useState<OfficeLiveOf | null>(null);
  useEffect(() => {
    if (!itemId) return;
    let live = true;
    ask().then(
      (answer) => live && setOf(answer),
      () => live && setOf(null),
    );
    return () => {
      live = false;
    };
    // `ask` is rebuilt each render; the tab's item is what changes the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);
  return of;
}
