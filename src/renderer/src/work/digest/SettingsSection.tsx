import { useEffect, useRef, useState } from "react";
import { DEFAULT_LEVEL, GROUP_NAMES, LEVEL_NAMES } from "@shared/work/digest";
import type { DigestField } from "@shared/contract-work-digest";
import { TELL_LEVELS, type TellGroup, type TellLevel } from "@shared/work/tell";
import { ChoiceSelect } from "../../components/choice-select";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../lib/connection";
import { refusedLine, unansweredLine } from "./notice";
import { hostsAgree, loadDigest, openDigestSheet, setDigest, useDigest } from "./store";

/**
 * Settings → Work → Digest (docs/DESIGN.md "The digest"): the time of the
 * day's one notice, and how loud four groups are. Every select starts at
 * "When it can't wait"; louder and quieter are one step each way. A change
 * is written to every host with Work on; the hosts that refused are named on
 * the row's red line, which stays until that row is written everywhere.
 */

/** The groups he sets, in the section's order. The rest stay at their clock and have no row. */
export const SETTING_GROUPS: readonly TellGroup[] = ["held", "results", "people", "meetings"];

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
  const nameOf = (environmentId: string): string => environments.find((e) => e.id === environmentId)?.name ?? "A host";
  // A row's red line: who refused its last write, and the value he asked for. It outlives edits to other rows, and
  // goes once every host holds that value, whoever wrote it there (his next write, or the window bringing a host to it).
  const [refused, setRefused] = useState<Partial<Record<DigestField, { line: string; want: string }>>>({});
  const refusal = (row: DigestField): string | undefined => {
    const r = refused[row];
    return r && !hostsAgree(row, r.want) ? r.line : undefined;
  };
  const [retrying, setRetrying] = useState(false);
  const settings = view.settings;
  // The field holds what he types; the hosts take it once it is a whole time and he has stopped.
  const [at, setAt] = useState<string | null>(null);
  const rest = useRef<number | null>(null);
  useEffect(() => {
    void loadDigest();
    return () => {
      if (rest.current !== null) window.clearTimeout(rest.current);
    };
  }, []);
  useEffect(() => setAt(null), [settings?.at]);

  const write = async (row: DigestField, want: string, patch: Parameters<typeof setDigest>[0]): Promise<void> => {
    const failed = await setDigest(patch);
    setRefused((prev) => {
      const next = { ...prev };
      if (failed.length === 0) delete next[row];
      else next[row] = { line: refusedLine(failed.map((f) => nameOf(f.environmentId))), want };
      return next;
    });
  };
  /** Writes the time when it is a whole one he changed; true when a write went out. */
  const writeAt = (next: string): boolean => {
    if (rest.current !== null) window.clearTimeout(rest.current);
    rest.current = null;
    if (!AT.test(next) || next === settings?.at) return false;
    // The field keeps what he typed until the hosts have answered: it never falls back to the old time meanwhile.
    void write("at", next, { at: next }).finally(() => setAt((now) => (now === next ? null : now)));
    return true;
  };

  const open = (
    <Button variant="ghost" size="sm" onClick={() => openDigestSheet(true)}>
      Open the digest
    </Button>
  );
  if (!settings) {
    return (
      <PageSection title="Digest" action={open}>
        {view.loaded ? (
          <PageError
            action={
              <Button
                variant="ghost"
                size="sm"
                disabled={retrying}
                onClick={() => {
                  setRetrying(true);
                  void loadDigest().finally(() => setRetrying(false));
                }}
              >
                <BusyLabel busy={retrying} label="Retry" />
              </Button>
            }
          >
            {/* In his words, as the list says it: never the link's own error text. */}
            {unansweredLine(view.errors.map((e) => nameOf(e.environmentId))) || "The digest's settings did not load"}
          </PageError>
        ) : (
          // Each control at the width its row lands with, so nothing moves.
          <PageRowsSkeleton rows={[{ control: "number", controlClassName: AT_WIDTH }, ...SETTING_GROUPS.map(() => ({ control: "select" as const, controlClassName: LEVEL_BONE }))]} />
        )}
      </PageSection>
    );
  }
  return (
    <PageSection title="Digest" action={open}>
      <PageRow title="Time" error={refusal("at")}>
        <Input
          type="time"
          aria-label="Time of the digest"
          className={cn(AT_WIDTH, "tabular-nums")}
          value={at ?? settings.at}
          onChange={(e) => {
            const next = e.target.value;
            setAt(next);
            if (rest.current !== null) window.clearTimeout(rest.current);
            rest.current = window.setTimeout(() => writeAt(next), AT_REST_MS);
          }}
          onBlur={() => {
            if (at === null || !writeAt(at)) setAt(null);
          }}
        />
      </PageRow>
      {SETTING_GROUPS.map((group) => (
        <PageRow key={group} title={GROUP_NAMES[group]} error={refusal(group)}>
          <ChoiceSelect<TellLevel>
            size="sm"
            // One width for the column of them: the longest level's, so their edges line up whatever each says.
            className={LEVEL_WIDTH}
            label={GROUP_NAMES[group]}
            value={settings.levels[group] ?? DEFAULT_LEVEL}
            options={LEVEL_CHOICES}
            onChange={(level) => void write(group, level, { levels: { [group]: level } })}
          />
        </PageRow>
      ))}
    </PageSection>
  );
}
