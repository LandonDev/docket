import { useEffect, useState } from "react";
import { DEFAULT_LEVEL, GROUP_NAMES, LEVEL_NAMES } from "@shared/work/digest";
import { TELL_LEVELS, type TellGroup, type TellLevel } from "@shared/work/tell";
import { ChoiceSelect } from "../../components/choice-select";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useEnvironments } from "../../lib/connection";
import { loadDigest, openDigestSheet, setDigest, useDigest } from "./store";

/**
 * Settings → Work → Digest (docs/DESIGN.md "The digest"): the time of the
 * day's one notice, and how loud three groups are. Every select starts at
 * "When it can't wait"; louder and quieter are one step each way. A change
 * is written to every host with Work on; a host that refused is the row's
 * red line.
 */

/** The groups he sets, in the section's order. The rest stay at their clock and have no row. */
export const SETTING_GROUPS: readonly TellGroup[] = ["held", "results", "people"];

const LEVEL_CHOICES = TELL_LEVELS.map((value) => ({ value, label: LEVEL_NAMES[value] }));
const AT = /^([01]\d|2[0-3]):[0-5]\d$/;

type Refusal = { row: string; line: string };

export function SettingsSection() {
  const view = useDigest();
  const environments = useEnvironments();
  const [refused, setRefused] = useState<Refusal | null>(null);
  const settings = view.settings;
  // The field holds what he types; the hosts take it once it is a whole time.
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    void loadDigest();
  }, []);
  useEffect(() => setAt(null), [settings?.at]);

  const write = async (row: string, patch: Parameters<typeof setDigest>[0]): Promise<void> => {
    setRefused(null);
    const failed = await setDigest(patch);
    if (failed.length === 0) return;
    const name = environments.find((e) => e.id === failed[0]!.environmentId)?.name ?? "A host";
    setRefused({ row, line: `${name} did not take it: ${failed[0]!.error}` });
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
              <Button variant="ghost" size="sm" onClick={() => void loadDigest()}>
                Retry
              </Button>
            }
          >
            {view.errors[0]?.error ?? "The digest's settings did not load"}
          </PageError>
        ) : (
          <PageRowsSkeleton rows={[{ control: "number" }, { control: "select" }, { control: "select" }, { control: "select" }]} />
        )}
      </PageSection>
    );
  }
  return (
    <PageSection title="Digest" action={open}>
      <PageRow title="Time" error={refused?.row === "at" ? refused.line : undefined}>
        <Input
          type="time"
          aria-label="Time of the digest"
          className="w-28 tabular-nums"
          value={at ?? settings.at}
          onChange={(e) => {
            const next = e.target.value;
            setAt(next);
            if (AT.test(next) && next !== settings.at) void write("at", { at: next });
          }}
          onBlur={() => setAt(null)}
        />
      </PageRow>
      {SETTING_GROUPS.map((group) => (
        <PageRow key={group} title={GROUP_NAMES[group]} error={refused?.row === group ? refused.line : undefined}>
          <ChoiceSelect<TellLevel>
            size="sm"
            label={GROUP_NAMES[group]}
            value={settings.levels[group] ?? DEFAULT_LEVEL}
            options={LEVEL_CHOICES}
            onChange={(level) => void write(group, { levels: { [group]: level } })}
          />
        </PageRow>
      ))}
    </PageSection>
  );
}
