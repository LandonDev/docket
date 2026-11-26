import { useEffect, useRef, useState } from "react";
import type { ReviewSettings } from "@server/shared/review";
import { registry } from "../lib/connection";
import { readWhenOpen, withDeadline } from "../lib/connection/openRead";
import { useRecheckWhileOffline } from "../lib/settingsHome";
import type { HarnessId } from "../lib/session";
import { EFFORT_LABELS, effortLadder, type Reasoning } from "../lib/tcserver/defaults";
import { resolveModel } from "../lib/models";
import { useRulesScope } from "../lib/tcserver/rules";
import { parseReviewScope, reviewerModel, reviewerModelOptions, type ReviewScope } from "../lib/reviewScope";

export { type ReviewScope } from "../lib/reviewScope";
import { HARNESS_LABEL } from "../lib/session";
import { settingEntry } from "../lib/settings/map";
import { ChoiceCombobox } from "../components/choice-combobox";
import { ChoiceSelect } from "../components/choice-select";
import { PageRow, PageRowsSkeleton } from "../components/page";
import { FieldRow } from "./DialogField";

type FieldControl = Parameters<typeof FieldRow>[0]["children"];
import { SettingSwitch } from "../components/setting-switch";
import { CommitField } from "../surfaces/settings/hosts/CommitField";
import { SettingRow } from "../surfaces/settings/parts/SettingRow";
import { ValueWords } from "../surfaces/settings/parts/ValueWords";
import type { Saved } from "../surfaces/settings/parts/useSaved";

/**
 * Review before merge (shared/review.ts): the fields, shared by Settings → Reviews (the one set, kept on the box) and
 * a project's sheet (its own set). Stored whole per scope (`review.set`): a project follows the one set or carries its
 * own.
 */

/** The harnesses a reviewer can run in: the ones that reach report_findings. */
const REVIEWER_PROVIDERS: HarnessId[] = ["codex", "claude"];

export const BLOCK_OPTIONS: { value: ReviewSettings["blockOn"]; label: string }[] = [
  { value: "confirmed", label: "Confirmed defects" },
  { value: "any", label: "Any finding" },
];

export type ReviewRow = "on" | "model" | "effort" | "stop" | "wait";
const ROW_ID: Record<ReviewRow, string> = { on: "reviews.on", model: "reviews.model", effort: "reviews.effort", stop: "reviews.stop", wait: "reviews.wait" };
const title = (row: ReviewRow): string => settingEntry(ROW_ID[row]).title;

/** The page's rows in their shape while `review.get` answers: the switch, then the four rows it shows while on, so
 *  the page holds its shape; with reviews off the answer only takes rows away. */
export function ReviewSkeleton() {
  return (
    <div data-testid="review-skeleton">
      <PageRowsSkeleton rows={[{ control: "switch" }, {}, {}, {}, { description: true, control: "number" }]} />
    </div>
  );
}

/** A scope's review set; the read waits for the socket to open. */
export async function loadReviewScope(environmentId: string, projectId: string | null): Promise<ReviewScope> {
  return parseReviewScope(await readWhenOpen(registry.linkOf(environmentId), "review.get", { projectId }));
}

/** A scope's review set, loaded on mount, asked again on every new socket
 *  until it has answered, with the last failure and a Retry. */
export function useReviewScope(environmentId: string, projectId: string | null) {
  const [scope, setScope] = useState<ReviewScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry, a socket opening during a miss or an offline-home check.
  const [attempt, setAttempt] = useState(0);
  // A load in flight waits for the open itself; only a settled miss asks again.
  const pending = useRef(false);
  const loaded = scope !== null;
  useEffect(() => {
    if (loaded) return;
    return registry.linkOf(environmentId).onOpen(() => {
      if (!pending.current) setAttempt((n) => n + 1);
    });
  }, [environmentId, loaded]);
  useEffect(() => {
    let live = true;
    pending.current = true;
    setError(null);
    const read = loadReviewScope(environmentId, projectId);
    // Past the deadline the error shows, and an answer that comes later still lands.
    read
      .then(
        (s) => {
          if (!live) return;
          setScope(s);
          setError(null);
        },
        () => {},
      )
      .finally(() => {
        if (live) pending.current = false;
      });
    withDeadline(read).catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [environmentId, projectId, attempt]);
  const retry = () => setAttempt((n) => n + 1);
  useRecheckWhileOffline(scope?.home, () => {
    if (!pending.current) retry();
  });
  return { scope, setScope, error, setError, retry };
}

export async function saveReviewSettings(
  environmentId: string,
  projectId: string | null,
  settings: ReviewSettings | null,
): Promise<void> {
  await registry.linkOf(environmentId).request("review.set", { projectId, settings });
}

export function ReviewFields({
  value,
  onChange,
  environmentId,
  compact = false,
  saved,
  disabled,
  readOnly = false,
}: {
  value: ReviewSettings;
  /** May return the save, so a control goes back when it is refused. */
  onChange: (next: ReviewSettings, row: ReviewRow) => void | Promise<unknown>;
  environmentId: string;
  /** The project sheet: plain rows, its own Save. */
  compact?: boolean;
  /** Each row's save on Settings → Reviews. */
  saved?: Record<ReviewRow, Saved>;
  disabled?: boolean;
  /** A key that may read the set but not change it: each value as words. */
  readOnly?: boolean;
}) {
  const { scope } = useRulesScope(environmentId, null);
  const rules = scope?.rules;
  const model = reviewerModel(value, environmentId);
  const ladder = model ? effortLadder(model) : [];
  const current = model ? (model.nativeId ?? model.id) : value.model;
  // One list over every reviewer app, grouped by app; a value is `provider:model`.
  const options = REVIEWER_PROVIDERS.flatMap((provider) =>
    reviewerModelOptions(provider, environmentId, rules).map((o) => ({ value: `${provider}:${o.value}`, label: o.label, group: HARNESS_LABEL[provider] })),
  );
  const chosen = `${value.provider}:${current}`;
  const modelOptions = options.some((o) => o.value === chosen) ? options : [{ value: chosen, label: model ? `${model.name} (not allowed)` : current }, ...options];
  const set = (row: ReviewRow, patch: Partial<ReviewSettings>) => {
    const next = { ...value, ...patch };
    const m = resolveModel(next.provider as HarnessId, next.model || undefined, environmentId);
    const steps = effortLadder(m);
    if (steps.length && !steps.includes(next.reasoning as Reasoning)) {
      const effort = m.settings?.find((s) => s.id === "effort");
      next.reasoning = (steps.includes(effort?.value as Reasoning) ? effort!.value : steps[0]) as ReviewSettings["reasoning"];
    }
    return onChange(next, row);
  };
  // A page's row with its save mark; in the project sheet (`compact`) a sheet's row, as its neighbours are.
  const words: Record<ReviewRow, string> = {
    on: value.beforeMerge ? "On" : "Off",
    model: modelOptions.find((o) => o.value === chosen)?.label ?? current,
    effort: EFFORT_LABELS[value.reasoning as Reasoning] ?? value.reasoning,
    stop: BLOCK_OPTIONS.find((o) => o.value === value.blockOn)?.label ?? value.blockOn,
    wait: `${value.maxMinutes} min`,
  };
  const row = (id: ReviewRow, input: FieldControl, description?: string) => {
    const control = readOnly ? <ValueWords>{words[id]}</ValueWords> : input;
    return saved ? (
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
  };

  return (
    <div data-slot="review-fields" className="flex flex-col">
      {row("on", <SettingSwitch label={title("on")} disabled={disabled} on={value.beforeMerge} onChange={(beforeMerge) => set("on", { beforeMerge })} />)}
      {value.beforeMerge ? (
        <>
          {row(
            "model",
            <ChoiceCombobox
              label={title("model")}
              disabled={disabled}
              value={chosen}
              options={modelOptions}
              onChange={(next) => {
                const at = next.indexOf(":");
                void set("model", { provider: next.slice(0, at) as ReviewSettings["provider"], model: next.slice(at + 1) });
              }}
            />,
          )}
          {ladder.length > 1
            ? row(
                "effort",
                <ChoiceSelect
                  label={title("effort")}
                  disabled={disabled}
                  value={value.reasoning}
                  options={ladder.map((level) => ({ value: level, label: EFFORT_LABELS[level] }))}
                  onChange={(reasoning) => void set("effort", { reasoning: reasoning as ReviewSettings["reasoning"] })}
                />,
              )
            : null}
          {row("stop", <ChoiceSelect label={title("stop")} disabled={disabled} value={value.blockOn} options={BLOCK_OPTIONS} onChange={(blockOn) => void set("stop", { blockOn })} />)}
          {row(
            "wait",
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <CommitField
                kind="int"
                min={1}
                max={240}
                aria-label={title("wait")}
                disabled={disabled}
                value={value.maxMinutes}
                onCommit={(maxMinutes) => Promise.resolve(set("wait", { maxMinutes: maxMinutes ?? value.maxMinutes })).then((landed) => landed !== false)}
                className="w-16 text-right tabular-nums"
              />
              min
            </span>,
            "Past it the merge goes ahead unreviewed",
          )}
        </>
      ) : null}
    </div>
  );
}
