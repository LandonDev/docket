import { useEffect, useRef, useState } from "react";
import { DEFAULT_LEVEL, LEVEL_NAMES } from "@shared/work/digest";
import type { DigestField } from "@shared/contract-work-digest";
import { TELL_LEVELS, type TellGroup, type TellLevel } from "@shared/work/tell";
import { ChoiceSelect } from "../../components/choice-select";
import { PageActions, PageError, PageRowsSkeleton, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../lib/connection";
import { useLinksMay } from "../../lib/linkMay";
import { useWorkHosts } from "../../lib/workSwitch";
import { settingTitle } from "../../lib/settings/map";
import { SaveMark } from "../../surfaces/settings/parts/SaveMark";
import { ManagedLine } from "../../surfaces/settings/parts/ManagedLine";
import { SettingRow, SettingSection } from "../../surfaces/settings/parts/SettingRow";
import { useSaved } from "../../surfaces/settings/parts/useSaved";
import { refusedLine, unansweredLine } from "./notice";
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

/** "Central Time, from the computer you used last": the zone the time is read in, by its everyday name. */
export function zoneWords(zone: string): string {
  let name = zone;
  try {
    name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? zone;
  } catch {
    // A zone the runtime does not know is said as the host gave it.
  }
  return `${name}, from the computer you used last`;
}

const LEVEL_CHOICES = TELL_LEVELS.map((value) => ({ value, label: LEVEL_NAMES[value] }));
const AT = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The time field's width and a level select's: the loading rows draw the same. */
const AT_WIDTH = "w-32";
const LEVEL_WIDTH = "w-44";
/** A small select is 28px tall; the stock loading select is a 32px one. */
const LEVEL_BONE = "h-7 w-44";

/** The time is written once he stops typing: a half-typed hour is not a time he chose. */
const AT_REST_MS = 600;

export function SettingsSection() {
  const view = useDigest();
  const environments = useEnvironments();
  const may = useLinksMay();
  const writable = [...useWorkHosts()].some((id) => may(id, "work.digest.set"));
  const workOn = useWorkHosts();
  // Who can change them, for a key that may set none: the computers with Work on, by name.
  const workNames = environments
    .filter((e) => workOn.has(e.id))
    .map((e) => e.name)
    .join(" and ");
  const nameOf = (environmentId: string): string => environments.find((e) => e.id === environmentId)?.name ?? "A computer";
  // A row's red line: who refused its last write, and the value he asked for. It outlives edits to other rows, and
  // goes once each host that refused is known to hold that value, whoever wrote it there (his next write, or the
  // window bringing a host to it).
  const [refused, setRefused] = useState<Partial<Record<DigestField, { line: string; want: string; hosts: string[] }>>>({});
  const refusal = (row: DigestField): string | undefined => {
    const r = refused[row];
    return r && !hostsHold(r.hosts, row, r.want) ? r.line : undefined;
  };
  const [retrying, setRetrying] = useState(false);
  const settings = view.settings;
  // The field holds what he types; the hosts take it once it is a whole time and he has stopped.
  const [at, setAt] = useState<string | null>(null);
  const rest = useRef<number | null>(null);
  // The time he typed that waits for him to stop, and the one on its way to the hosts.
  const waiting = useRef<string | null>(null);
  const sending = useRef<string | null>(null);
  useEffect(() => {
    void loadDigest();
    return () => {
      // He left before the rest was over: what he typed is written, not dropped.
      if (rest.current !== null) window.clearTimeout(rest.current);
      if (waiting.current && AT.test(waiting.current) && waiting.current !== sending.current) void setDigest({ at: waiting.current });
    };
  }, []);
  // The hosts caught up with what he typed: the field reads them again. Another time arriving (an earlier save's
  // answer, another window's change) never takes a draft he is still on.
  useEffect(() => setAt((draft) => (draft === settings?.at ? null : draft)), [settings?.at]);

  const atSaved = useSaved();
  const write = async (row: DigestField, want: string, patch: Parameters<typeof setDigest>[0]): Promise<boolean> => {
    const failed = await setDigest(patch);
    setRefused((prev) => {
      const next = { ...prev };
      if (failed.length === 0) delete next[row];
      else next[row] = { line: refusedLine(failed.map((f) => nameOf(f.environmentId))), want, hosts: failed.map((f) => f.environmentId) };
      return next;
    });
    return failed.length === 0;
  };
  /** Writes the time when it is a whole one he changed; true when it is on its way (now, or already). */
  const writeAt = (next: string): boolean => {
    if (rest.current !== null) window.clearTimeout(rest.current);
    rest.current = null;
    waiting.current = null;
    // Already on its way: leaving the field does not send the same time twice.
    if (sending.current === next) return true;
    // The time the hosts hold already is no change, unless another time is on its way to them: going back to it
    // then is his latest edit, and is sent after the one before it.
    if (!AT.test(next) || (next === settings?.at && sending.current === null)) return false;
    sending.current = next;
    // The field keeps what he typed until the hosts have answered: it never falls back to the old time meanwhile,
    // and only this edit's own answer lets go of it.
    void atSaved.run(() => write("at", next, { at: next })).finally(() => {
      if (sending.current === next) sending.current = null;
      setAt((draft) => (draft === next ? null : draft));
    });
    return true;
  };

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
          <PageSection>
            <PageError
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  className="-me-2.5"
                  disabled={retrying}
                  onClick={() => {
                    setRetrying(true);
                    void loadDigest().finally(() => setRetrying(false));
                  }}
                >
                  <BusyLabel busy={retrying} label="Retry" align="end" />
                </Button>
              }
            >
              {/* In his words, as the list says it: never the link's own error text. */}
              {unansweredLine(view.errors.map((e) => nameOf(e.environmentId))) || "The digest's settings did not load"}
            </PageError>
          </PageSection>
        ) : (
          // Each control at the width its row lands with, so nothing moves.
          <>
            <SettingSection of="digest.at">
              <PageRowsSkeleton rows={[{ description: true, control: "number", controlClassName: AT_WIDTH }]} />
            </SettingSection>
            <SettingSection of="digest.waiting">
              <PageRowsSkeleton rows={SETTING_GROUPS.map(() => ({ control: "select" as const, controlClassName: LEVEL_BONE }))} />
            </SettingSection>
          </>
        )}
      </>
    );
  }
  const at12 = new Date(`2000-01-01T${settings.at}`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return (
    <>
      {open}
      <SettingSection of="digest.at">
        <SettingRow id="digest.at" description={zoneWords(settings.zone)} error={refusal("at")}>
          {writable ? (
            <>
              <SaveMark state={atSaved.state} />
              <Input
                type="time"
                aria-label="Arrives at"
                className={cn(AT_WIDTH, "tabular-nums")}
                value={at ?? settings.at}
                onChange={(e) => {
                  const next = e.target.value;
                  setAt(next);
                  waiting.current = next;
                  if (rest.current !== null) window.clearTimeout(rest.current);
                  rest.current = window.setTimeout(() => writeAt(next), AT_REST_MS);
                }}
                onBlur={() => {
                  if (at === null || !writeAt(at)) setAt(null);
                }}
              />
            </>
          ) : (
            <span className="text-xs text-muted-foreground tabular-nums">{at12}</span>
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
        {writable ? null : <ManagedLine computer={workNames} />}
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
