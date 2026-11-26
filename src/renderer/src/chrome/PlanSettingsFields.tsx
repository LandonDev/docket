import type { PlanSettings } from "@server/shared/plans";
import { registry } from "../lib/connection";
import { HARNESS_LABEL } from "../lib/session";
import { allModels, findModel, nativeModelId } from "../lib/models";
import { settingEntry } from "../lib/settings/map";
import { ReadFailure } from "../surfaces/settings/parts/ReadFailure";
import { homeNote } from "../lib/settingsHome";
import { EFFORT_LABELS, REASONING_LEVELS, effortLadder } from "../lib/tcserver/defaults";
import { savePlanSettings, usePlanSettings, usePlanSettingsError } from "../lib/tcserver/plans";
import { ChoiceCombobox } from "../components/choice-combobox";
import { ChoiceSelect } from "../components/choice-select";
import { PageRow, PageRowsSkeleton } from "../components/page";
import { FieldRow } from "./DialogField";

type FieldControl = Parameters<typeof FieldRow>[0]["children"];
import { SettingSwitch } from "../components/setting-switch";
import { SettingRow, SettingSection } from "../surfaces/settings/parts/SettingRow";
import { useDraft } from "../surfaces/settings/parts/useDraft";
import { useSaved, type Saved } from "../surfaces/settings/parts/useSaved";

/**
 * Builds from plans (plans.ts): what happens when a plan is done. Whether the build starts on its own, whether the
 * plan's thread is archived once it has, and the model, effort and context the build runs with, each "Same as the
 * plan" unless set. One set on the box for every computer (New threads' second section), and a project's own set in
 * its sheet (`compact`).
 */

type Row = "start" | "archive" | "model" | "effort" | "context";
const ROW_ID: Record<Row, string> = { start: "plans.start", archive: "plans.archive", model: "plans.model", effort: "plans.effort", context: "plans.context" };

const SAME = { value: "", label: "Same as the plan" };

/** "Same as the plan" is a choice, not an empty field: it reads in the value's tone, as the model's list does. */
const CHOSEN = "data-placeholder:text-foreground";

export function PlanSettingsFields({
  value,
  onChange,
  environmentId,
  compact = false,
  saved,
  disabled,
}: {
  value: PlanSettings;
  /** May return the save, so a switch goes back when it is refused. */
  onChange: (next: PlanSettings, row: Row) => void | Promise<unknown>;
  environmentId?: string;
  /** The project sheet: plain rows, its own Save. */
  compact?: boolean;
  /** Each row's save on the New threads page. */
  saved?: Record<Row, Saved>;
  disabled?: boolean;
}) {
  const set = (row: Row, patch: Partial<PlanSettings>) => onChange({ ...value, ...patch }, row);
  const fixed = value.implementModel ? findModel(value.implementModel) : undefined;
  const ladder = fixed ? effortLadder(fixed) : [...REASONING_LEVELS];
  const models = allModels(environmentId);
  const known = !value.implementModel || models.some((m) => nativeModelId(m) === value.implementModel);
  const modelOptions = [
    SAME,
    ...models.map((m) => ({ value: nativeModelId(m), label: m.name, group: HARNESS_LABEL[m.harness] })),
    ...(known ? [] : [{ value: value.implementModel, label: value.implementModel }]),
  ];
  const reasoningOptions = [
    SAME,
    ...ladder.map((level) => ({ value: level, label: EFFORT_LABELS[level] })),
    ...(value.implementReasoning && !ladder.includes(value.implementReasoning) ? [{ value: value.implementReasoning, label: EFFORT_LABELS[value.implementReasoning] }] : []),
  ];
  const size = compact ? "sm" : "default";
  const title = (row: Row) => settingEntry(ROW_ID[row]).title;
  // A page's row with its save mark; in the project sheet (`compact`) a sheet's row, as its neighbours are.
  const row = (id: Row, control: FieldControl, description?: string) =>
    saved ? (
      <SettingRow key={id} id={ROW_ID[id]} saved={saved[id]} description={description}>
        {control}
      </SettingRow>
    ) : compact ? (
      <FieldRow key={id} label={title(id)}>
        {control}
      </FieldRow>
    ) : (
      <PageRow key={id} title={title(id)} description={description}>
        {control}
      </PageRow>
    );
  return (
    <>
      {row("start", <SettingSwitch label={title("start")} disabled={disabled} on={value.autoImplement} onChange={(on) => set("start", { autoImplement: on })} />)}
      {row("archive", <SettingSwitch label={title("archive")} disabled={disabled} on={value.archiveAfterStart} onChange={(on) => set("archive", { archiveAfterStart: on })} />)}
      {row(
        "model",
        <ChoiceCombobox label={title("model")} size={size} disabled={disabled} value={value.implementModel} options={modelOptions} onChange={(implementModel) => set("model", { implementModel })} />,
      )}
      {row(
        "effort",
        <ChoiceSelect
          label={title("effort")}
          className={CHOSEN}
          size={size}
          disabled={disabled}
          value={value.implementReasoning}
          options={reasoningOptions}
          onChange={(implementReasoning) => set("effort", { implementReasoning: implementReasoning as PlanSettings["implementReasoning"] })}
        />,
      )}
      {row(
        "context",
        <ChoiceSelect
          label={title("context")}
          className={CHOSEN}
          size={size}
          disabled={disabled}
          value={value.implementContext}
          options={[SAME, { value: "1m", label: "1M" }, { value: "200k", label: "200k" }]}
          onChange={(implementContext) => set("context", { implementContext: implementContext as PlanSettings["implementContext"] })}
        />,
      )}
    </>
  );
}

/** The rows in their shape while the set loads: two switches, three selects. */
const PLANS_SKELETON = [{ control: "switch" as const }, { control: "switch" as const }, {}, {}, {}];

/** New threads' "Builds from plans": the one set, saving on every change, each row with its mark. `quiet`: the page
 *  already says this read failed (with the other's, the same computer's), so the section draws nothing: no second red
 *  line, and no bones, which would say it is still waiting. */
export function PlanSettingsEditor({ quiet = false }: { quiet?: boolean }) {
  const environmentId = registry.primary().environmentId;
  const scope = usePlanSettings(environmentId, null);
  const failure = usePlanSettingsError(environmentId, null);
  const draft = useDraft(scope?.settings);
  const saved: Record<Row, Saved> = { start: useSaved(), archive: useSaved(), model: useSaved(), effort: useSaved(), context: useSaved() };
  const { blocked } = homeNote(scope?.home);
  const change = (next: PlanSettings, row: Row) => draft.change(saved[row], next, (set) => savePlanSettings(environmentId, null, set));
  // Quiet: only the failure, which draws nothing beside the page's same line but lends that line's Retry this read.
  if (quiet && !draft.value && failure) return <ReadFailure computer={environmentId} error={failure.error} retry={failure.retry} />;
  return (
    <SettingSection of="plans.start">
      {draft.value ? (
        <PlanSettingsFields value={draft.value} onChange={change} environmentId={environmentId} saved={saved} disabled={blocked} />
      ) : failure ? (
        <ReadFailure computer={environmentId} error={failure.error} retry={failure.retry} />
      ) : (
        <PageRowsSkeleton rows={PLANS_SKELETON} />
      )}
    </SettingSection>
  );
}
