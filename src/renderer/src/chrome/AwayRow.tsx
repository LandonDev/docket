import { useEffect } from "react";
import type { AwayKind, AwayKinds } from "@server/shared/away";
import { SWITCH_THUMB, SWITCH_TRACK } from "../components/ui/switch-track";
import { awayKinds, setAway, startAway, toggleAway, useAway, usePlaceAwayKind } from "../lib/away";
import { cn } from "../lib/cn";
import { clockTime } from "../lib/duration";
import { useWorkOn } from "../lib/workSwitch";
import { Moon } from "./icons";
import { RowsContextMenu, type MenuRow } from "./menuRows";
import { RailRow } from "./RailRow";

export const AWAY_LABEL = "Away from computer";

const KIND_WORD: Record<AwayKind, string> = { code: "Code", work: "Work" };

/** The row's label: which kinds are away, in words, or the plain name while none is. */
export function awayLabel(kinds: AwayKinds): string {
  if (kinds.code && kinds.work) return "Away for both";
  if (kinds.code) return "Away for Code";
  if (kinds.work) return "Away for Work";
  return AWAY_LABEL;
}

/** The row's hover line: what the press does to this place's kind while off, since when while on. */
export function awayTooltip(enabled: boolean, at: number, kind?: AwayKind): string {
  const who = kind ? `${KIND_WORD[kind]} threads` : "Threads";
  return enabled && at > 0 ? `${kind ? `${who} away` : "Away"} since ${clockTime(at)}` : `${who} decide without asking you`;
}

/** The kind menu: each kind with its tick, then Both and Off. */
export function awayMenuRows(kinds: AwayKinds): MenuRow[] {
  return [
    { kind: "item", id: "code", label: "Code threads", checked: kinds.code },
    { kind: "item", id: "work", label: "Work threads", checked: kinds.work },
    { kind: "sep" },
    { kind: "item", id: "both", label: "Both", disabled: kinds.code && kinds.work },
    { kind: "item", id: "off", label: "Off", disabled: !kinds.code && !kinds.work },
  ];
}

/** A pick from the kind menu, as the flip it asks for. */
export function pickAway(pick: string): void {
  if (pick === "code" || pick === "work") toggleAway(pick);
  else if (pick === "both") void setAway({ code: true, work: true });
  else if (pick === "off") void setAway({ code: false, work: false });
}

/**
 * The rail foot's Away switch: one row, a moon, the label and a still track
 * at its end. The press flips this place's kind (Code in a code place, Work
 * in a Work place); the label names the kinds away in words; the context
 * menu (right-click, the menu key) sets each kind, Both or Off. While no host
 * has Work, the row is Code's alone and has no menu. The flip shows at once (lib/away.ts `setAway`) and
 * rolls back with a toast when the host refuses it.
 */
export function AwayRow() {
  const { code, work, at } = useAway();
  const place = usePlaceAwayKind();
  const workOn = useWorkOn();
  useEffect(() => startAway(), []);
  const kinds = { code, work };
  // No host has Work: the row is Code's alone. It never sets Work by implication: a Work thread made
  // while Work was on keeps its scope, and only his own Work switch speaks for it.
  if (!workOn) return <AwayRowView kinds={{ code, work: false }} checked={code} at={at} onToggle={() => toggleAway("code")} />;
  return (
    <RowsContextMenu label="Away from computer" lazyMount rowsFor={() => awayMenuRows(awayKinds())} onPick={(pick) => pickAway(pick)}>
      <div data-menu-id="away">
        <AwayRowView kinds={kinds} checked={kinds[place]} place={place} at={at} onToggle={() => toggleAway(place)} />
      </div>
    </RowsContextMenu>
  );
}

/** The row as it draws, for a state: the store's (AwayRow) or a fixture's. `checked` is the place's kind; `place` is left out where there is one kind. */
export function AwayRowView({ kinds, checked, place, at, onToggle }: { kinds: AwayKinds; checked: boolean; place?: AwayKind; at: number; onToggle: () => void }) {
  const any = kinds.code || kinds.work;
  const on = checked ? "true" : "false";
  return (
    <RailRow
      icon={Moon}
      label={place ? awayLabel(kinds) : AWAY_LABEL}
      checked={checked}
      glyphClassName={any ? "text-warning" : undefined}
      className={any ? "text-foreground" : undefined}
      tooltip={awayTooltip(checked, at, place)}
      onClick={onToggle}
      trailing={
        <span aria-hidden data-slot="away-track" data-on={on} className={cn(SWITCH_TRACK, "data-[on=true]:bg-warning")}>
          <span className={cn(SWITCH_THUMB, "group-data-[on=true]/switch:bg-background")} />
        </span>
      }
    />
  );
}
