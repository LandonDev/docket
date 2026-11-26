import { Fragment, useEffect, useMemo, useState } from "react";
import { useWorkspaces } from "../lib/tcserver/workspaces";
import { registry } from "../lib/connection";
import { useEnvironmentStatuses } from "../lib/connection/status";
import { TruncateTip } from "../components/tip";
import { MoreHorizontal } from "./icons";
import { HarnessIcon } from "./HarnessIcon";
import { confirmAction, DialogFooter, ErrorLine } from "./ConfirmDialog";
import { RowsMenu, type MenuRow } from "./menuRows";
import { Facts } from "../surfaces/settings/hosts/Facts";
import { ChoiceSelect, type Choice } from "../components/choice-select";
import { ChoiceCombobox } from "../components/choice-combobox";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton } from "../components/page";
import { SettingSwitch } from "../components/setting-switch";
import { Button } from "../components/ui/button";
import { Field, FieldRow } from "./DialogField";
import { Modal, ModalBody, useClosingDialog, useModalClose } from "./Modal";
import { Input } from "../components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { cn } from "../lib/cn";
import { EFFORT_LABELS } from "../lib/tcserver/defaults";
import {
  modelApproved,
  modelKey,
  moveRoutingRule,
  newRuleId,
  patchModelPolicy,
  removeRoutingRule,
  rulesStore,
  sliceLadder,
  staleModels,
  upsertRoutingRule,
  useRulesScope,
  type ModelPolicy,
  type OrchestrationRules,
  type RoutingRule,
  type RulesCatalog,
} from "../lib/tcserver/rules";
import { usePublishHome } from "../lib/settings/pageHome";
import { resolveModel } from "../lib/models";
import { ReadFailure } from "../surfaces/settings/parts/ReadFailure";
import { homeNote } from "../lib/settingsHome";
import { HARNESS_TITLE, type HarnessId } from "../lib/session";
import type { ModelInfo, ProviderId, Reasoning as Effort } from "../lib/tcserver/types";
import { OpenCue, SettingRow, SettingSection } from "../surfaces/settings/parts/SettingRow";
import { ListFilter, useListFilter } from "../surfaces/settings/parts/ListFilter";
import { SaveMark } from "../surfaces/settings/parts/SaveMark";
import { useSaved, type Saved } from "../surfaces/settings/parts/useSaved";

/**
 * Subagents (server/shared/rules.ts; docs/agents/settings.md "The pages: Everywhere"): what a lead thread that starts
 * agents does itself and its limits, which models agents may run on (a sheet), and the rules that say which model
 * gets which work, in order. One set on the box for every computer; a code workspace may keep its own (the same
 * editor, `workspaceId`). Every change saves at once with its row's mark; a refusal slides the control back and the
 * row's red line says why. While the box that keeps the set is out of reach the controls are held.
 */

type Delegation = OrchestrationRules["conduct"]["delegation"];

/** "Gives its agents": Everything (strict) or Everything but small tasks (balanced). A set saved with `free` keeps
 *  that value, shown by its own name, until he picks one of the two. */
const DELEGATION_LABELS: Record<Delegation, string> = {
  strict: "Everything",
  balanced: "Everything but small tasks",
  free: "Only what is faster to hand off",
};
const delegationChoices = (current: Delegation): Choice<Delegation>[] =>
  (current === "free" ? (["strict", "balanced", "free"] as const) : (["strict", "balanced"] as const)).map((value) => ({ value, label: DELEGATION_LABELS[value] }));

type Approval = "everyone" | "orchestrators" | "off";

/** "Who may start it": every thread, only a lead thread (one that starts agents), or none. */
const APPROVAL_OPTIONS: Choice<Approval>[] = [
  { value: "everyone", label: "Everyone" },
  { value: "orchestrators", label: "Lead threads only" },
  { value: "off", label: "Off" },
];

/** An agent app's name, as every other page says it ("Claude Code"), else the catalog's own word for it. */
const appName = (catalog: RulesCatalog | null, provider: ProviderId): string => (HARNESS_TITLE as Record<string, string>)[provider] ?? catalog?.[provider]?.label ?? provider;

/** A model's one name, the one every page says ("Claude Opus 5.5"): the app's full name for it where this window knows
 *  the model, else the catalog's own word. */
const modelName = (provider: ProviderId, id: string, label: string): string => {
  const model = resolveModel(provider as HarnessId, id);
  return model.harness === provider && (model.id === id || model.nativeId === id) ? model.name : label;
};

/** Every agent app the computer's catalog lists, in its order. */
const providersOf = (catalog: RulesCatalog | null): ProviderId[] => Object.keys(catalog ?? {}) as ProviderId[];

/** A model's effort ladder as its computer serves it, cut to the policy's bounds. */
const ladderOf = (rules: OrchestrationRules, provider: ProviderId, model: ModelInfo | undefined): Effort[] =>
  model ? sliceLadder(rules, provider, model.id, model.reasoning) : [];

const effortChoices = (levels: readonly Effort[]): Choice<Effort>[] => levels.map((level) => ({ value: level, label: EFFORT_LABELS[level] }));

type ConductRow = "gives" | "edits" | "commands" | "checks" | "retries" | "checkout" | "atOnce" | "perThread";
type SwitchKey = "selfEdit" | "selfShell" | "verifyResults" | "escalate" | "useWorktrees";
const SWITCHES: { row: ConductRow; id: string; key: SwitchKey }[] = [
  { row: "edits", id: "sub.edits", key: "selfEdit" },
  { row: "commands", id: "sub.commands", key: "selfShell" },
  { row: "checks", id: "sub.checks", key: "verifyResults" },
  { row: "retries", id: "sub.retries", key: "escalate" },
  { row: "checkout", id: "sub.checkout", key: "useWorktrees" },
];

/** Each section's rows in their shape while the set loads: the lead thread's select and five switches, the two
 *  limits, the models' open row, two rules. */
const LEAD_SKELETON = [{}, { control: "switch" }, { control: "switch" }, { control: "switch" }, { control: "switch" }, { control: "switch" }] as const;
const LIMITS_SKELETON = [{}, {}] as const;
const MODELS_SKELETON = [{ description: true, control: "none" }] as const;
const RULES_SKELETON = [{ description: true, media: true, control: "none" }, { description: true, media: true, control: "none" }] as const;

/** The page while the set loads, every section under its real heading in its rows' shape. Once its computer has
 *  failed to answer, only the one line with Retry (`ReadFailure`): no headings and no bones, which would say it still
 *  waits. */
export function RulesSkeleton({ environmentId, error, onRetry }: { workspaceId?: string | null; environmentId?: string; error?: string | null; onRetry?: () => void }) {
  if (error && environmentId) return <ReadFailure computer={environmentId} error={error} retry={onRetry ?? (() => {})} />;
  return (
    <div data-testid="rules-skeleton" className="contents">
      <SettingSection of="sub.gives">
        <PageRowsSkeleton rows={LEAD_SKELETON} />
      </SettingSection>
      <SettingSection of="sub.atOnce" description={LIMITS_LINE}>
        <PageRowsSkeleton rows={LIMITS_SKELETON} />
      </SettingSection>
      <SettingSection of="sub.models">
        <PageRowsSkeleton rows={MODELS_SKELETON} />
      </SettingSection>
      <SettingSection of="sub.routing">
        <PageRowsSkeleton rows={RULES_SKELETON} />
      </SettingSection>
    </div>
  );
}

/** Both limits count for one lead thread: said once, under their heading. */
const LIMITS_LINE = "For each thread.";

export function OrchestrationRulesEditor({ workspaceId }: { workspaceId: string | null }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  // The one set is asked of this window's own computer, which forwards it to the box.
  const environmentId = workspaceId === null ? registry.primary().environmentId : workspace?.environmentId;
  if (!environmentId) return <RulesSkeleton />;
  return <RulesEditor key={environmentId} environmentId={environmentId} workspaceId={workspaceId} />;
}

export function RulesEditor({ environmentId, workspaceId }: { environmentId: string; workspaceId: string | null }) {
  const { scope, catalog, error, retry } = useRulesScope(environmentId, workspaceId, true);
  const [editing, setEditing] = useState<RoutingRule | "new" | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const saved: Record<ConductRow, Saved> = {
    gives: useSaved(),
    edits: useSaved(),
    commands: useSaved(),
    checks: useSaved(),
    retries: useSaved(),
    checkout: useSaved(),
    atOnce: useSaved(),
    perThread: useSaved(),
  };
  const cleared = useSaved();
  const moved = useSaved();
  usePublishHome("orchestration", workspaceId === null ? (scope ? (scope.home ?? null) : undefined) : undefined);
  // A computer's link coming or going may move where the copy can be written: the answer says so again.
  const statuses = useEnvironmentStatuses();
  const linkStates = [...statuses.values()].map((s) => s.transport).join();
  useEffect(() => {
    void rulesStore.load(environmentId, workspaceId, true).catch(() => undefined);
  }, [environmentId, workspaceId, linkStates]);

  if (!scope) return <RulesSkeleton environmentId={environmentId} error={error} onRetry={retry} />;
  const { rules, overridden } = scope;
  const { blocked } = homeNote(scope.home);

  // The store shows the change at once and puts the last set back on a refusal; the row's save says which.
  const write = (next: OrchestrationRules) => rulesStore.save(environmentId, workspaceId, next);
  const patchConduct = (row: ConductRow, patch: Partial<OrchestrationRules["conduct"]>) => saved[row].run(() => write({ ...rules, conduct: { ...rules.conduct, ...patch } }));
  const reset = async () => {
    const ok = await confirmAction(
      workspaceId === null
        ? { title: "Use Docket's defaults", body: "Every row on this page goes back to Docket's, and every rule for which model gets which work is deleted.", action: "Use Docket's defaults", danger: true }
        : { title: "Use Subagents", body: "This workspace's own set is deleted. Its threads follow Subagents.", action: "Use Subagents", danger: true },
    );
    if (ok) void cleared.run(() => rulesStore.clear(environmentId, workspaceId));
  };
  const move = (from: number, to: number) => void moved.run(() => write(moveRoutingRule(rules, from, to)));

  const models = providersOf(catalog).flatMap((p) => (catalog?.[p]?.models ?? []).map((m) => ({ provider: p, id: m.id })));
  // The models an agent may run: "Lead threads only" is not one, so it is not counted.
  const allowed = models.filter((m) => modelApproved(rules, m.provider, m.id)).length;

  return (
    <>
      <SettingSection of="sub.gives">
        <SettingRow id="sub.gives" saved={saved.gives}>
          <ChoiceSelect
            label="Gives its agents"
            value={rules.conduct.delegation}
            options={delegationChoices(rules.conduct.delegation)}
            disabled={blocked}
            onChange={(delegation) => void patchConduct("gives", { delegation })}
          />
        </SettingRow>
        {SWITCHES.map(({ row, id, key }) => (
          <SettingRow key={id} id={id} saved={saved[row]}>
            <SettingSwitch label={TITLES[row]} on={rules.conduct[key]} disabled={blocked} onChange={(on) => patchConduct(row, { [key]: on } as Partial<OrchestrationRules["conduct"]>)} />
          </SettingRow>
        ))}
      </SettingSection>

      <SettingSection of="sub.atOnce" description={LIMITS_LINE}>
        <SettingRow id="sub.atOnce" saved={saved.atOnce}>
          <CapSelect label="Agents at once" value={rules.conduct.maxParallel} options={[0, 2, 4, 8, 16, 32, 64, 128]} disabled={blocked} onChange={(maxParallel) => void patchConduct("atOnce", { maxParallel })} />
        </SettingRow>
        <SettingRow id="sub.perThread" saved={saved.perThread}>
          <CapSelect label="Agents in all" value={rules.conduct.maxAgents} options={[0, 10, 20, 50]} disabled={blocked} onChange={(maxAgents) => void patchConduct("perThread", { maxAgents })} />
        </SettingRow>
      </SettingSection>

      <SettingSection of="sub.models">
        <SettingRow id="sub.models" description={catalog ? `${allowed} of ${models.length} allowed` : undefined} onOpen={() => setModelsOpen(true)} openLabel="Models agents may run on" />
      </SettingSection>

      <SettingSection
        of="sub.routing"
        action={
          // Nothing is offered that cannot work: while the box is out of reach there is no Add rule….
          blocked ? null : (
            <Button variant="ghost" size="sm" data-setting="sub.addRule" onClick={() => setEditing("new")}>
              Add rule…
            </Button>
          )
        }
      >
        {rules.routing.map((r, i) => (
          <RuleRow key={r.id} rule={r} rules={rules} catalog={catalog} disabled={blocked} first={i === 0} last={i === rules.routing.length - 1} onEdit={() => setEditing(r)} onMove={(by) => move(i, i + by)} />
        ))}
        {rules.routing.length === 0 ? <PageEmpty>No rules</PageEmpty> : null}
        {moved.error ? <PageError>{moved.error}</PageError> : null}
      </SettingSection>

      {/* Asks first, so last on the page; offered only while there is a set to clear and the box can take it. */}
      {overridden && !blocked ? (
        <SettingSection of="sub.reset">
          {workspaceId === null ? (
            <SettingRow id="sub.reset" description="Every row here goes back, and every rule is deleted" saved={cleared}>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void reset()}>
                Use…
              </Button>
            </SettingRow>
          ) : (
            <PageRow title="This workspace's own set" description="Its threads follow Subagents once it is gone" error={cleared.error ?? undefined}>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void reset()}>
                Use Subagents…
              </Button>
            </PageRow>
          )}
        </SettingSection>
      ) : null}

      {modelsOpen ? <ModelsSheet rules={rules} catalog={catalog} disabled={blocked} write={write} onClose={() => setModelsOpen(false)} /> : null}
      {editing ? (
        <RuleDialog
          rule={editing === "new" ? null : editing}
          rules={rules}
          catalog={catalog}
          onSave={(rule) => write(upsertRoutingRule(rules, rule))}
          onDelete={editing === "new" ? undefined : () => write(removeRoutingRule(rules, editing.id))}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

const TITLES: Record<ConductRow, string> = {
  gives: "Gives its agents",
  edits: "May edit files itself",
  commands: "May run commands itself",
  checks: "Checks its agents' work",
  retries: "Retries with a stronger model",
  checkout: "Gives each agent its own checkout",
  atOnce: "Agents at once",
  perThread: "Agents per thread",
};

function CapSelect({ label, value, options, disabled, onChange }: { label: string; value: number; options: number[]; disabled?: boolean; onChange: (v: number) => void }) {
  const values = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <ChoiceSelect
      label={label}
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      disabled={disabled}
      options={values.map((o) => ({ value: String(o), label: o === 0 ? "No limit" : String(o) }))}
    />
  );
}

/** "Models agents may run on": every model of every agent app this computer has, a find field over them, who may
 *  start each and its lowest and highest effort. Each change saves as it is made. */
function ModelsSheet({
  rules,
  catalog,
  disabled,
  write,
  onClose,
}: {
  rules: OrchestrationRules;
  catalog: RulesCatalog | null;
  disabled: boolean;
  write: (next: OrchestrationRules) => Promise<void>;
  onClose: () => void;
}) {
  const { root } = useClosingDialog(onClose, false);
  const stale = catalog ? staleModels(rules, catalog) : [];
  const rows = providersOf(catalog).flatMap((p) => [
    ...(catalog?.[p]?.models ?? []).map((m) => ({ provider: p, id: m.id, model: m as ModelInfo | undefined, name: modelName(p, m.id, m.label) })),
    ...stale.filter((m) => m.provider === p).map((m) => ({ provider: p, id: m.id, model: undefined, name: m.id })),
  ]);
  const filter = useListFilter(rows, (row) => `${row.name} ${appName(catalog, row.provider)}`);
  const shown = new Set(filter.shown);
  return (
    <Sheet {...root}>
      <SheetContent side="right" width={640}>
        <SheetHeader>
          <SheetTitle>Models agents may run on</SheetTitle>
        </SheetHeader>
        {/* The sheet's own column is the page container the model rows read their width from. */}
        <div className="@container/page min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pb-5">
          <ListFilter filter={filter} label="Find a model" />
          <Table>
            <TableHeader className="@max-[36rem]/page:hidden">
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Who may start it</TableHead>
                <TableHead className="text-end">Effort</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providersOf(catalog).map((p) => {
                const info = catalog?.[p];
                const label = appName(catalog, p);
                const mine = rows.filter((row) => row.provider === p && shown.has(row));
                if (filter.query && mine.length === 0) return null;
                return (
                  <Fragment key={p}>
                    <TableRow data-slot="table-group-row" className="border-b-0">
                      <TableCell colSpan={3} className="h-8 pt-2">
                        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                          <HarnessIcon harness={p as HarnessId} className="size-3.5 shrink-0" />
                          {label}
                        </span>
                      </TableCell>
                    </TableRow>
                    {(info?.models.length ?? 0) === 0 && !filter.query ? (
                      <TableRow data-slot="table-empty-row">
                        <TableCell colSpan={3} className="h-auto min-h-10 py-3 text-xs whitespace-normal text-muted-foreground">
                          No models until {label} is installed and signed in
                        </TableCell>
                      </TableRow>
                    ) : null}
                    {mine.map((row) => (
                      <ModelRow key={`${row.model ? "" : "stale:"}${row.id}`} provider={p} id={row.id} model={row.model} rules={rules} disabled={disabled} write={write} />
                    ))}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * A model's row under 36rem of its column: the name on a line of its own, then who may start it and its effort pair
 * on the next, so the Effort column never runs past the table's edge. The effort selects are one width (w-28, the
 * widest rung, "Extra high"), so the pairs line up down the table.
 */
const MODEL_ROW = "@max-[36rem]/page:flex @max-[36rem]/page:flex-wrap @max-[36rem]/page:items-center @max-[36rem]/page:gap-x-3 @max-[36rem]/page:gap-y-1 @max-[36rem]/page:py-2";
const MODEL_NAME = "@max-[36rem]/page:h-5 @max-[36rem]/page:max-w-none @max-[36rem]/page:basis-full @max-[36rem]/page:px-0";
const MODEL_CONTROL = "@max-[36rem]/page:h-auto @max-[36rem]/page:px-0";

/** One model's policy. With no `model` the rules name a model this computer's catalog lacks: its row stays, muted and
 *  without effort, so the saved policy is seen and kept. */
function ModelRow({
  provider,
  id,
  model,
  rules,
  disabled,
  write,
}: {
  provider: ProviderId;
  id: string;
  model?: ModelInfo;
  rules: OrchestrationRules;
  disabled?: boolean;
  write: (next: OrchestrationRules) => Promise<void>;
}) {
  const saved = useSaved();
  // A lead-threads-only model keeps its effort bounds: it is allowed for someone. A model the saved rules do not
  // list reads Off.
  const policy = rules.models[modelKey(provider, id)]?.approved ?? false;
  const approved = policy !== false;
  const name = model ? modelName(provider, model.id, model.label) : id;
  const range = ladderOf(rules, provider, model);
  const ladder = model?.reasoning ?? [];
  const min = range[0];
  const max = range[range.length - 1];
  const change = (patch: Partial<ModelPolicy>) => void saved.run(() => write(patchModelPolicy(rules, provider, id, patch)));
  return (
    <TableRow data-stale={model ? undefined : ""} className={MODEL_ROW}>
      {/* `max-w-0` bounds the cell to what the controls leave, so a long name is cut here, never pushing the effort
          pair past the table's edge. */}
      <TableCell className={cn("w-full max-w-0", MODEL_NAME, approved && model ? "text-foreground" : "text-muted-foreground")}>
        <TruncateTip text={model ? name : `${name}, not on this computer`}>
          <span data-slot="model-name" className="block truncate">
            {name}
            {model ? null : <span className="ms-1 text-xs">not on this computer</span>}
          </span>
        </TruncateTip>
        {saved.error ? <span className="block text-xs whitespace-normal text-destructive">{saved.error}</span> : null}
      </TableCell>
      <TableCell className={MODEL_CONTROL}>
        <span className="flex items-center justify-end gap-2">
          <SaveMark state={saved.state} />
          <ChoiceSelect
            size="sm"
            label={`Who may start ${name}`}
            value={policy === true ? "everyone" : policy === false ? "off" : "orchestrators"}
            onChange={(v) => change({ approved: v === "everyone" ? true : v === "off" ? false : "orchestrators" })}
            options={APPROVAL_OPTIONS}
            disabled={disabled}
            className="w-44"
          />
        </span>
      </TableCell>
      <TableCell className={cn("text-end", MODEL_CONTROL)}>
        {approved && ladder.length > 1 ? (
          <span className="inline-flex items-center gap-2">
            <ChoiceSelect
              size="sm"
              label={`${name} lowest effort`}
              value={min}
              disabled={disabled}
              options={effortChoices(ladder.slice(0, ladder.indexOf(max) + 1))}
              onChange={(v) => change({ minReasoning: v === ladder[0] ? undefined : v })}
              className="w-28"
            />
            <span className="text-muted-foreground">to</span>
            <ChoiceSelect
              size="sm"
              label={`${name} highest effort`}
              value={max}
              disabled={disabled}
              options={effortChoices(ladder.slice(ladder.indexOf(min)))}
              onChange={(v) => change({ maxReasoning: v === ladder[ladder.length - 1] ? undefined : v })}
              className="w-28"
            />
          </span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/** One rule: the row opens its dialog; its ⋯ moves it up or down the list, since the first rule that fits decides. */
function RuleRow({
  rule,
  rules,
  catalog,
  disabled,
  first,
  last,
  onEdit,
  onMove,
}: {
  rule: RoutingRule;
  rules: OrchestrationRules;
  catalog: RulesCatalog | null;
  disabled?: boolean;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const provider = catalog?.[rule.provider];
  const modelId = rule.model || provider?.defaultModel || "";
  const model = provider?.models.find((m) => m.id === modelId);
  const approved = modelApproved(rules, rule.provider, modelId);
  const leadOnly = !approved && modelApproved(rules, rule.provider, modelId, "orchestrator");
  const menu: MenuRow[] = [
    { kind: "item", id: "up", label: "Move up", disabled: first },
    { kind: "item", id: "down", label: "Move down", disabled: last },
  ];
  return (
    <PageRow
      data-rule={rule.id}
      title={<span className={rule.enabled ? undefined : "text-muted-foreground"}>{rule.task}</span>}
      media={<HarnessIcon harness={rule.provider as HarnessId} className="size-4 shrink-0" />}
      description={
        <Facts
          parts={[
            rule.enabled ? null : "Off",
            model ? modelName(rule.provider, model.id, model.label) : modelId,
            model?.reasoning.length ? EFFORT_LABELS[rule.reasoning] : null,
            leadOnly ? "Lead threads only" : !approved ? <span className="text-warning">Not allowed</span> : null,
          ]}
        />
      }
      onOpen={onEdit}
      openLabel={`Edit rule: ${rule.task}`}
      openDisabled={disabled}
    >
      {/* The ⋯ only moves a rule, so a lone rule, or a set the box cannot take now, has none: the row ends in its cue. */}
      {(first && last) || disabled ? (
        <OpenCue />
      ) : (
        <RowsMenu
          label={`${rule.task} actions`}
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`${rule.task} actions`} className="text-muted-foreground">
              <MoreHorizontal />
            </Button>
          }
          rows={() => menu}
          onPick={(id) => onMove(id === "up" ? -1 : 1)}
          align="end"
        />
      )}
    </PageRow>
  );
}

type RuleDialogProps = {
  rule: RoutingRule | null;
  rules: OrchestrationRules;
  catalog: RulesCatalog | null;
  /** Saves the rule; a refusal keeps the dialog open with the reason. */
  onSave: (r: RoutingRule) => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
  onClose: () => void;
};

export function RuleDialog(props: RuleDialogProps) {
  return (
    <Modal onClose={props.onClose} title={props.rule ? "Edit rule" : "Add rule"} size="sm">
      <RuleForm {...props} />
    </Modal>
  );
}

/** Save and Delete… change the rules, then play the dialog's exit; a refusal stays, its reason over the footer. */
function RuleForm({ rule, rules, catalog, onSave, onDelete, onClose }: RuleDialogProps) {
  const close = useModalClose();
  const providers = providersOf(catalog).filter((p) => (catalog?.[p]?.models.length ?? 0) > 0);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [task, setTask] = useState(rule?.task ?? "");
  const [provider, setProvider] = useState<ProviderId>(rule?.provider ?? providers[0] ?? "claude");
  const [model, setModel] = useState(rule?.model ?? "");
  const [reasoning, setReasoning] = useState<Effort>(rule?.reasoning ?? "medium");
  const [running, setRunning] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const models = useMemo(() => (catalog?.[provider]?.models ?? []).filter((m) => modelApproved(rules, provider, m.id)), [catalog, provider, rules]);
  const effective = model || catalog?.[provider]?.defaultModel || "";
  const ladder = useMemo(() => ladderOf(rules, provider, models.find((m) => m.id === effective)), [models, effective, rules, provider]);
  // Keep effort valid for the picked model (render-time adjust).
  if (ladder.length && !ladder.includes(reasoning)) setReasoning(ladder[0]);

  const run = async (which: "save" | "delete", change: () => Promise<unknown>) => {
    setRunning(which);
    setError(null);
    try {
      await change();
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^refused:\s*/i, "") : String(err));
      setRunning(null);
    }
  };
  const save = () => {
    if (!task.trim()) return;
    void run("save", () => onSave({ id: rule?.id ?? newRuleId(), task: task.trim(), provider, model, reasoning, enabled }));
  };
  const remove = async () => {
    if (!onDelete) return;
    const ok = await confirmAction({ title: "Delete this rule", body: `“${rule?.task}” is deleted. Its work goes to the next rule that fits.`, action: "Delete", danger: true });
    if (ok) void run("delete", onDelete);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <ModalBody>
        <Field label="When the task is">
          <Input autoFocus value={task} onChange={(e) => setTask(e.target.value)} placeholder="Bulk or mechanical work with a clear spec" />
        </Field>
        <div className="flex flex-col">
          <FieldRow label="Agent app">
            <ChoiceSelect
              label="Agent app"
              size="sm"
              value={provider}
              onChange={(v) => {
                setProvider(v);
                setModel("");
              }}
              options={providers.map((p) => ({ value: p, label: appName(catalog, p) }))}
            />
          </FieldRow>
          <FieldRow label="Model">
            <ChoiceCombobox label="Model" size="sm" value={model} onChange={setModel} options={[{ value: "", label: "Default" }, ...models.map((m) => ({ value: m.id, label: modelName(provider, m.id, m.label) }))]} />
          </FieldRow>
          {ladder.length > 1 ? (
            <FieldRow label="Effort">
              <ChoiceSelect label="Effort" size="sm" value={reasoning} onChange={setReasoning} options={effortChoices(ladder)} />
            </FieldRow>
          ) : null}
          {rule ? (
            <FieldRow label="Use this rule">
              <SettingSwitch label="Use this rule" on={enabled} onChange={setEnabled} />
            </FieldRow>
          ) : null}
        </div>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter
        start={
          onDelete ? (
            <Button type="button" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={running !== null} onClick={() => void remove()}>
              Delete…
            </Button>
          ) : null
        }
        onCancel={onClose}
        confirmLabel="Save"
        pending={running === "save"}
        busy={running === "delete"}
        disabled={!task.trim()}
      />
    </form>
  );
}
