import { useEffect, useState } from "react";
import { DEFAULT_LEVEL, LEVEL_NAMES } from "@shared/work/digest";
import type { DigestField } from "@shared/contract-work-digest";
import { TELL_LEVELS, type TellGroup, type TellLevel } from "@shared/work/tell";
import { ChoiceSelect } from "../../components/choice-select";
import { PageActions, PageRowsSkeleton, PageSection } from "../../components/page";
import { Button } from "../../components/ui/button";
import { ChoiceCombobox } from "../../components/choice-combobox";
import { cn } from "../../lib/cn";

/** A line's first word in capitals: "this Mac did not take it" opens as "This Mac…". */
const opening = (line: string): string => line.charAt(0).toUpperCase() + line.slice(1);

/** "the box", "the box and MacBook Pro", "the box, PURDUE-LT and MacBook Pro". */
const listOf = (names: readonly string[]): string => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
import { useEnvironments } from "../../lib/connection";
import { useLinksMay } from "../../lib/linkMay";
import { useWorkHosts } from "../../lib/workSwitch";
import { settingTitle } from "../../lib/settings/map";
import { SaveMark } from "../../surfaces/settings/parts/SaveMark";
import { ManagedLine } from "../../surfaces/settings/parts/ManagedLine";
import { ReadFailure } from "../../surfaces/settings/parts/ReadFailure";
import { computerInLine, useComputerNames } from "../../lib/settings/computerName";
import { thisDesktopInLine } from "../../lib/native";
import { SettingRow, SettingSection } from "../../surfaces/settings/parts/SettingRow";
import { useSaved } from "../../surfaces/settings/parts/useSaved";
import { refusedLine } from "./notice";
import { hostsHold, loadDigest, openDigestSheet, setDigest, useDigest } from "./store";

/**
 * Settings → Digest (docs/DESIGN.md "The digest", docs/agents/settings.md "The pages: Work"): when the day's one
 * notice arrives, with the zone it follows, and how loud four groups are. Every select starts at "When it can't
 * wait"; louder and quieter are one step each way. One set for every computer with Work on, by design, as the page's
 * line says: a change is written to each, and those that refused are named on the row's red line, which stays until
 * that row is written everywhere. A computer this window's key may not set (its admin rule) is never written; with
 * none it may, the time and levels stand as plain words. "Open the digest" stands on the page's title line.
 */

/** The groups he sets, in the page's order. The rest stay at their clock and have no row. */
export const SETTING_GROUPS: readonly TellGroup[] = ["held", "results", "people", "meetings"];
/** Each group's row in the map (lib/settings/map.ts). */
export const GROUP_ROWS: Record<string, string> = { held: "digest.waiting", results: "digest.routines", people: "digest.messages", meetings: "digest.meetings" };

/**
 * "Central Time, this Mac's", or "Central Time, from the computer you used last": the zone the time is read in, by its
 * everyday name. The host keeps the zone of the desktop that last came to the front, not which desktop that was, so
 * only this window's own computer can be named.
 */
export function zoneWords(zone: string, here: string = Intl.DateTimeFormat().resolvedOptions().timeZone, mac = thisDesktopInLine()): string {
  let name = zone;
  try {
    name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? zone;
  } catch {
    // A zone the runtime does not know is said as the host gave it.
  }
  return zone === here ? `${name}, ${mac}'s` : `${name}, from the computer you used last`;
}

const LEVEL_CHOICES = TELL_LEVELS.map((value) => ({ value, label: LEVEL_NAMES[value] }));
const AT = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The time field's width and a level select's: the loading rows draw the same. */
const AT_WIDTH = "w-32";
const LEVEL_WIDTH = "w-44";
/** A small select is 28px tall; the stock loading select is a 32px one. */
const LEVEL_BONE = "h-7 w-44";

/** "7:30 AM": a wall time as the page says it, in 12 hours with no leading zero. */
export const clock12 = (at: string): string => new Date(`2000-01-01T${at}`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** Every quarter hour of the day, and the time held now where it is off that step, in order. */
export function timeChoices(held: string): { value: string; label: string }[] {
  const times = new Set<string>([held]);
  for (let m = 0; m < 24 * 60; m += 15) times.add(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  return [...times].filter((t) => AT.test(t)).sort().map((value) => ({ value, label: clock12(value) }));
}

export function SettingsSection() {
  const view = useDigest();
  const environments = useEnvironments();
  const may = useLinksMay();
  const writable = [...useWorkHosts()].some((id) => may(id, "work.digest.set"));
  const workOn = useWorkHosts();
  // Who can change them, for a key that may set none: the computers with Work on, by name.
  const names = useComputerNames();
  const workNames = listOf(environments.filter((e) => workOn.has(e.id)).map((e) => computerInLine(names(e.id))));
  // A row's red line: who refused its last write, and the value he asked for. It outlives edits to other rows, and
  // goes once each host that refused is known to hold that value, whoever wrote it there (his next write, or the
  // window bringing a host to it).
  const [refused, setRefused] = useState<Partial<Record<DigestField, { line: string; want: string; hosts: string[] }>>>({});
  const refusal = (row: DigestField): string | undefined => {
    const r = refused[row];
    return r && !hostsHold(r.hosts, row, r.want) ? r.line : undefined;
  };
  const settings = view.settings;
  useEffect(() => void loadDigest(), []);

  const atSaved = useSaved();
  // The time he chose, shown at once until the computers answer.
  const [atShown, setAtShown] = useState<string | null>(null);
  const write = async (row: DigestField, want: string, patch: Parameters<typeof setDigest>[0]): Promise<boolean> => {
    const failed = await setDigest(patch);
    setRefused((prev) => {
      const next = { ...prev };
      if (failed.length === 0) delete next[row];
      else next[row] = { line: opening(refusedLine(failed.map((f) => computerInLine(names(f.environmentId))))), want, hosts: failed.map((f) => f.environmentId) };
      return next;
    });
    return failed.length === 0;
  };
  // The computers that did not answer, one line each, together at the page's head.
  const failures = view.errors.length ? (
    <PageSection>
      {view.errors.map((e) => (
        <ReadFailure key={e.environmentId} computer={e.environmentId} error={e.error} retry={loadDigest} />
      ))}
    </PageSection>
  ) : null;
  const open = (
    <PageActions>
      <Button variant="ghost" size="sm" onClick={() => openDigestSheet(true)}>
        Open the digest
      </Button>
    </PageActions>
  );
  if (!settings) {
    return (
      <>
        {open}
        {view.loaded ? (
          // Each computer that did not answer, named once on the page, its Retry asking every read again.
          failures
                ) : (
          // Each control at the width its row lands with, so nothing moves.
          <>
            <SettingSection of="digest.at">
              <PageRowsSkeleton rows={[{ description: true, control: "select", controlClassName: "h-7 w-32" }]} />
            </SettingSection>
            <SettingSection of="digest.waiting">
              <PageRowsSkeleton rows={SETTING_GROUPS.map(() => ({ control: "select" as const, controlClassName: LEVEL_BONE }))} />
            </SettingSection>
          </>
        )}
      </>
    );
  }
  return (
    <>
      {open}
      {/* Part of the computers answered: what came stands, the others are named with Retry, and the set is not
          said to be the same everywhere until every one has answered. */}
      {failures}
      <SettingSection of="digest.at" description={workNames && !failures ? `Kept the same on ${workNames}` : undefined}>
        {writable ? null : <ManagedLine computer={workNames} />}
        <SettingRow id="digest.at" description={zoneWords(settings.zone)} error={refusal("at")}>
          {writable ? (
            <>
              <SaveMark state={atSaved.state} />
              <ChoiceCombobox
                size="sm"
                label="Arrives at"
                className={cn(AT_WIDTH, "tabular-nums")}
                value={atShown ?? settings.at}
                options={timeChoices(atShown ?? settings.at)}
                onChange={(next) => {
                  if (next === settings.at) return;
                  setAtShown(next);
                  void atSaved.run(() => write("at", next, { at: next })).finally(() => setAtShown(null));
                }}
              />
            </>
          ) : (
            <span className="text-xs text-muted-foreground tabular-nums">{clock12(settings.at)}</span>
          )}
        </SettingRow>
      </SettingSection>
      <SettingSection of="digest.waiting">
        {SETTING_GROUPS.map((group) => (
          <LevelRow
            key={group}
            group={group}
            value={settings.levels[group] ?? DEFAULT_LEVEL}
            writable={writable}
            error={refusal(group)}
            onChange={(level) => write(group, level, { levels: { [group]: level } })}
          />
        ))}
      </SettingSection>
    </>
  );
}

/** One group's level: the select moves at once, and goes back to what the computers hold if they refuse it. */
function LevelRow({ group, value, writable, error, onChange }: { group: TellGroup; value: TellLevel; writable: boolean; error?: string; onChange: (level: TellLevel) => Promise<boolean> }) {
  const saved = useSaved();
  const [shown, setShown] = useState<TellLevel | null>(null);
  const id = GROUP_ROWS[group]!;
  return (
    <SettingRow id={id} error={error}>
      {writable ? (
        <>
          <SaveMark state={saved.state} />
          <ChoiceSelect<TellLevel>
            size="sm"
            // One width for the column of them: the longest level's, so their edges line up whatever each says.
            className={LEVEL_WIDTH}
            label={settingTitle(id)}
            value={shown ?? value}
            options={LEVEL_CHOICES}
            onChange={(level) => {
              setShown(level);
              void saved.run(() => onChange(level)).finally(() => setShown(null));
            }}
          />
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{LEVEL_NAMES[value]}</span>
      )}
    </SettingRow>
  );
}
