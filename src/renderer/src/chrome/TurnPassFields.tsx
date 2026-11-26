import { useRef } from "react";
import {
  TURN_PASS_OFF,
  passEnabled,
  type TurnPass,
} from "@server/shared/turnpass";
import { linkOfWorkspace } from "../lib/tcserver/projects";
import { useHostRead } from "../lib/connection/hostRead";
import type { Link } from "../lib/connection";
import { useLinkMay } from "../lib/linkMay";
import { settingTitle } from "../lib/settings/map";
import { BusyLabel, Button } from "../components/ui/button";
import { ChoiceSelect } from "../components/choice-select";
import { PageError, PageRowsSkeleton } from "../components/page";
import { SettingSwitch } from "../components/setting-switch";
import { Switch } from "../components/ui/switch";
import { FieldRow } from "./DialogField";
import { SettingRow, SettingSection } from "../surfaces/settings/parts/SettingRow";
import { useSaved, type Saved } from "../surfaces/settings/parts/useSaved";

/**
 * After each turn: what an implementation or orchestration thread does once a turn settles and before anything
 * queued. Stored per workspace (`turnpass.set`), with a per-project set the project sheet edits.
 */

export const COMMIT_OPTIONS: { value: TurnPass["commit"]; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "commit", label: "Commit" },
  { value: "push", label: "Commit and push" },
];

const commitWords = (commit: TurnPass["commit"]): string => COMMIT_OPTIONS.find((o) => o.value === commit)?.label ?? "Off";

/** The three choices as a dialog's rows (the project sheet), each a `FieldRow` like the sheet's others. */
export function TurnPassFieldRows({ value, onChange }: { value: TurnPass; onChange: (next: TurnPass) => void }) {
  return (
    <>
      <FieldRow label={settingTitle("ws.checks")}>
        <Switch aria-label={settingTitle("ws.checks")} checked={value.verify} onCheckedChange={(verify) => onChange({ ...value, verify })} />
      </FieldRow>
      <FieldRow label={settingTitle("ws.build")}>
        <Switch aria-label={settingTitle("ws.build")} checked={value.build} onCheckedChange={(build) => onChange({ ...value, build })} />
      </FieldRow>
      <FieldRow label={settingTitle("ws.commit")}>
        <ChoiceSelect label={settingTitle("ws.commit")} size="sm" value={value.commit} options={COMMIT_OPTIONS} onChange={(commit) => onChange({ ...value, commit })} />
      </FieldRow>
    </>
  );
}

export function parseTurnPass(raw: unknown): TurnPass | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const commit = COMMIT_OPTIONS.some((o) => o.value === r.commit)
    ? (r.commit as TurnPass["commit"])
    : "off";
  return { verify: r.verify === true, build: r.build === true, commit };
}

export async function loadTurnPass(
  workspaceId: string,
  projectId?: string,
): Promise<TurnPass | null> {
  const raw = await linkOfWorkspace(workspaceId).request("turnpass.get", { workspaceId, projectId });
  return parseTurnPass(raw);
}

export async function saveTurnPass(
  workspaceId: string,
  pass: TurnPass | null,
  projectId?: string,
): Promise<void> {
  await linkOfWorkspace(workspaceId).request("turnpass.set", {
    workspaceId,
    projectId,
    pass: pass && passEnabled(pass) ? pass : null,
  });
}

/** The three rows, in their shape. */
const TURN_PASS_SKELETON = [{ control: "switch" }, { control: "switch" }, { control: "select" }] as const;

/** The workspace's host link, or null while the catalog does not know it yet. */
function linkOrNull(workspaceId: string): Link | null {
  try {
    return linkOfWorkspace(workspaceId);
  } catch {
    return null;
  }
}

/**
 * A code workspace's After each turn: Run the checks, Make a fresh build, Commit. Each saves at once with the mark; a
 * refusal puts back what the host last confirmed (unless a newer change is on its way, whose own answer decides) with
 * the row's red line. No answer to the read is the section's error with Retry. A key that may not set it reads the
 * values as words.
 */
/**
 * A workspace's pass as its computer answers it, with the value it last confirmed. The workspace page asks it once, as
 * the read the whole page hangs on, and hands it to `TurnPassEditor`.
 */
export function useTurnPassRead(workspaceId: string) {
  const confirmed = useRef<TurnPass | null>(null);
  const read = useHostRead(
    linkOrNull(workspaceId),
    async () => {
      const pass = (await loadTurnPass(workspaceId)) ?? TURN_PASS_OFF;
      confirmed.current = pass;
      return pass;
    },
    workspaceId,
  );
  return { read, confirmed };
}

export type TurnPassRead = ReturnType<typeof useTurnPassRead>;

export function TurnPassEditor({ workspaceId, pass }: { workspaceId: string; pass?: TurnPassRead }) {
  const own = useTurnPassRead(pass ? "" : workspaceId);
  const { read, confirmed } = pass ?? own;
  const link = linkOrNull(workspaceId);
  const may = useLinkMay(link?.environmentId ?? "", "turnpass.set");
  // The newest change: an older refusal puts nothing back while it is on its way.
  const latest = useRef(0);
  const checks = useSaved();
  const build = useSaved();
  const commit = useSaved();
  const value = read.value;

  const change = (saved: Saved, next: TurnPass): Promise<boolean> => {
    const n = ++latest.current;
    read.set(next);
    return saved.run(async () => {
      try {
        await saveTurnPass(workspaceId, next);
        confirmed.current = next;
      } catch (err) {
        if (n === latest.current && confirmed.current) read.set(confirmed.current);
        throw err;
      }
    });
  };
  const words = (on: boolean): string => (on ? "On" : "Off");

  return (
    <SettingSection of="ws.checks">
      {value ? (
        <>
          <SettingRow id="ws.checks" saved={may ? checks : undefined} description={may ? undefined : words(value.verify)}>
            {may ? <SettingSwitch label={settingTitle("ws.checks")} on={value.verify} onChange={(verify) => change(checks, { ...value, verify })} /> : null}
          </SettingRow>
          <SettingRow id="ws.build" saved={may ? build : undefined} description={may ? undefined : words(value.build)}>
            {may ? <SettingSwitch label={settingTitle("ws.build")} on={value.build} onChange={(on) => change(build, { ...value, build: on })} /> : null}
          </SettingRow>
          <SettingRow id="ws.commit" saved={may ? commit : undefined} description={may ? undefined : commitWords(value.commit)}>
            {may ? <ChoiceSelect label={settingTitle("ws.commit")} value={value.commit} options={COMMIT_OPTIONS} onChange={(next) => void change(commit, { ...value, commit: next })} /> : null}
          </SettingRow>
        </>
      ) : read.error ? (
        <PageError
          action={
            <Button variant="ghost" size="sm" onClick={read.retry}>
              <BusyLabel busy={false} label="Retry" />
            </Button>
          }
        >
          {read.error}
        </PageError>
      ) : (
        <PageRowsSkeleton rows={TURN_PASS_SKELETON} />
      )}
    </SettingSection>
  );
}
