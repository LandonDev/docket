import { useEffect, useState } from "react";
import type { PlayRow, RoutineRow } from "@shared/contract-work-routines";
import type { ToolRulesCard } from "@shared/contract-work-outbox";
import type { MsFormView } from "@shared/contract-work-msforms";
import { confirmAction, DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { ChoiceToggle, type ToggleChoice } from "../../components/choice-toggle";
import { BusyLabel, Button } from "../../components/ui/button";
import { DateField } from "../../components/ui/date-field";
import { Input } from "../../components/ui/input";
import { TimeField } from "../../components/ui/time-field";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { registry } from "../../lib/connection";
import { workErrorWords } from "../../lib/workErrorWords";
import { blankForm, DAY_CHOICES, EVENT_CHOICES, EVERY_CHOICES, FORM_JOBS, formOf, saveParamsOf, type EndsOn, type RoutineForm, type StartsOn } from "./model";

type Props = {
  env: string;
  workspaceId: string;
  /** null: a new routine; a proposal: his Add */
  row: RoutineRow | null;
  onClose: () => void;
  onSaved: (row: RoutineRow) => void;
};

const STARTS: ToggleChoice<StartsOn>[] = [
  { value: "sched", label: "Schedule" },
  { value: "event", label: "LifeOS" },
  { value: "read", label: "Read" },
  { value: "file", label: "File" },
];
const ENDS: ToggleChoice<EndsOn>[] = [
  { value: "never", label: "Never" },
  { value: "day", label: "On a day" },
  { value: "once", label: "After one run" },
];
const MONO = "font-mono text-xs";

/**
 * New routine, Edit, and Add on an agent's proposal (prototype
 * routines.html, "A form"): what to do, then what starts it, whose fields
 * the four-part control swaps, then when it ends. An end makes it a watch.
 */
export function RoutineDialog(props: Props) {
  const [pending, setPending] = useState(false);
  const title = props.row === null ? "New routine" : props.row.proposed ? "Add routine" : "Edit routine";
  return (
    <Modal onClose={props.onClose} title={title} size="md" busy={pending}>
      <Body {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

/** The tools a read may watch: only those he set to Runs, in this workspace or allowed in Work. */
function useRunsTools(env: string, workspaceId: string): { value: string; label: string }[] | null {
  const [tools, setTools] = useState<{ value: string; label: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    registry
      .linkOf(env)
      .request<{ addons: ToolRulesCard[] }>("work.outbox.rules", { workspaceId })
      .then(
        ({ addons }) =>
          live &&
          setTools(
            addons
              .filter((a) => !a.lifeos && (a.workspaceId === workspaceId || a.forWork))
              .flatMap((a) => a.tools.filter((t) => t.rule === "runs" && !t.changed).map((t) => ({ value: `${a.addonId}\n${t.tool}`, label: `${a.name}: ${t.words}` }))),
          ),
        () => live && setTools([]),
      );
    return () => {
      live = false;
    };
  }, [env, workspaceId]);
  return tools;
}

/** The plays a routine may run: his own that take nothing (docs/agents/work-plays.md), and the one it runs now whatever it takes. */
function useRunnablePlays(env: string, workspaceId: string, current: string | null): { value: string; label: string }[] {
  const [plays, setPlays] = useState<PlayRow[]>([]);
  useEffect(() => {
    let live = true;
    registry
      .linkOf(env)
      .request<{ plays: PlayRow[] }>("work.routines.plays", { workspaceId })
      .then(
        (r) => live && setPlays(r.plays),
        () => live && setPlays([]),
      );
    return () => {
      live = false;
    };
  }, [env, workspaceId]);
  return plays.filter((p) => !p.proposed && (p.takes.length === 0 || p.id === current)).map((p) => ({ value: p.id, label: p.name }));
}

/** The job's Microsoft forms a routine may watch for answers (docs/agents/work-msforms.md); none where the pillar does not answer. */
function useJobForms(env: string, workspaceId: string): { value: string; label: string }[] | null {
  const [forms, setForms] = useState<{ value: string; label: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    registry
      .linkOf(env)
      .request<{ forms: MsFormView[] }>("work.msforms.list", { workspaceId })
      .then(
        (r) => live && setForms((r.forms ?? []).map((f) => ({ value: f.formId, label: f.title }))),
        () => live && setForms([]),
      );
    return () => {
      live = false;
    };
  }, [env, workspaceId]);
  return forms;
}

/** A job the Runs select offers is named apart from a play's id. */
const JOB_VALUE = "job:";

function Body({ env, workspaceId, row, onClose, onSaved, pending, setPending }: Props & { pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const [form, setForm] = useState<RoutineForm>(() => (row ? formOf(row) : blankForm()));
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const patch = (next: Partial<RoutineForm>) => setForm((cur) => ({ ...cur, ...next }));
  // A trigger he did not touch is saved as it was, whatever the form can show of it (an agent's every 5 minutes, Mon, Wed and Fri).
  const [touched, setTouched] = useState(false);
  const patchTrigger = (next: Partial<RoutineForm>) => {
    setTouched(true);
    patch(next);
  };
  const tools = useRunsTools(env, workspaceId);
  const plays = useRunnablePlays(env, workspaceId, row?.playId ?? null);
  const forms = useJobForms(env, workspaceId);
  // A routine that runs a job the form cannot offer (the review's) has no words and no model to write: its form is when it runs.
  const job = Boolean(row?.job) && !FORM_JOBS.some((j) => j.value === row?.job);
  // On a Microsoft form's answers the Runs select also offers the form's jobs, and one picked needs no words.
  const onForm = form.starts === "file" && Boolean(form.form);
  const runsJob = onForm && Boolean(form.job);
  const runs = [{ value: "", label: "What you write here" }, ...plays, ...(onForm ? FORM_JOBS.map((j) => ({ value: `${JOB_VALUE}${j.value}`, label: j.label })) : [])];
  const repeat = form.days.startsWith("m");
  const finish = (then: () => void) => (close ? close(then) : then());

  const save = () => {
    const params = saveParamsOf(form, row, { workspaceId, host: env, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", touched });
    if (typeof params === "string") return setError(params);
    setError(null);
    setPending(true);
    registry
      .linkOf(env)
      .request<RoutineRow>("work.routines.save", params)
      .then(
        (saved) => {
          setPending(false);
          finish(() => onSaved(saved));
        },
        (err: unknown) => {
          setPending(false);
          setError(workErrorWords(err) || "The host refused it");
        },
      );
  };

  const remove = async () => {
    if (!row) return;
    if (!(await confirmAction({ title: `Delete “${row.name}”?`, action: "Delete", danger: true }))) return;
    setRemoving(true);
    registry
      .linkOf(env)
      .request("work.routines.remove", { id: row.id })
      .then(
        () => finish(() => {}),
        (err: unknown) => {
          setRemoving(false);
          setError(workErrorWords(err) || "The host refused it");
        },
      );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <ModalBody>
        <Field label="Name">
          <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Morning sweep" autoComplete="off" />
        </Field>
        {runs.length > 1 && !job ? (
          <Field label="Runs">
            <ChoiceSelect
              label="Runs"
              className="w-full"
              value={runsJob ? `${JOB_VALUE}${form.job}` : form.play}
              options={runs}
              onChange={(v) => (v.startsWith(JOB_VALUE) ? patch({ job: v.slice(JOB_VALUE.length), play: "" }) : patch({ play: v, job: "" }))}
            />
          </Field>
        ) : null}
        {job || runsJob ? null : (
          <Field label={form.play ? "Also" : "What to do"}>
            <Textarea rows={3} value={form.prompt} onChange={(e) => patch({ prompt: e.target.value })} placeholder={form.play ? "Anything this routine adds to the play" : "In your words"} />
          </Field>
        )}
        <div className="flex flex-col gap-3">
          <FieldRow label="Starts">
            <ChoiceToggle label="Starts" value={form.starts} options={STARTS} onChange={(starts) => patchTrigger({ starts })} />
          </FieldRow>
          {form.starts === "sched" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Days">
                <ChoiceSelect label="Days" className="w-full" value={form.days} options={DAY_CHOICES} onChange={(days) => patchTrigger({ days })} />
              </Field>
              {repeat ? null : (
                <Field label="At">
                  <TimeField required value={form.at} onChange={(at) => patchTrigger({ at })} />
                </Field>
              )}
            </div>
          ) : form.starts === "event" ? (
            <Field label="When">
              <ChoiceSelect label="When" className="w-full" value={form.event} options={EVENT_CHOICES} onChange={(event) => patchTrigger({ event })} />
            </Field>
          ) : form.starts === "read" ? (
            tools !== null && tools.length === 0 ? (
              <p className="text-xs text-muted-foreground">A read needs a tool set to Runs in Settings → Work.</p>
            ) : (
              <>
                <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3">
                  <Field label="Read">
                    {tools === null ? (
                      <Skeleton aria-label="Loading the tools" className="h-8 w-full rounded-lg" />
                    ) : (
                      <ChoiceSelect label="Read" className="w-full" value={form.tool} options={[{ value: "", label: "Pick a tool" }, ...tools]} onChange={(tool) => patchTrigger({ tool })} />
                    )}
                  </Field>
                  <Field label="Every">
                    <ChoiceSelect label="Every" className="w-full" value={form.every} options={EVERY_CHOICES} onChange={(every) => patchTrigger({ every })} />
                  </Field>
                </div>
                <Field label="With" hint="The tool's arguments, fixed now">
                  <Input value={form.args} onChange={(e) => patchTrigger({ args: e.target.value })} spellCheck={false} autoComplete="off" className={MONO} />
                </Field>
              </>
            )
          ) : (
            <>
              {forms?.length || form.form ? (
                <Field label="File" hint={form.form ? "When someone answers it" : undefined}>
                  {forms === null ? (
                    <Skeleton aria-label="Loading the forms" className="h-8 w-full rounded-lg" />
                  ) : (
                    <ChoiceSelect
                      label="File"
                      className="w-full"
                      value={form.form}
                      options={[{ value: "", label: "A file by its path" }, ...forms, ...(form.form && !forms.some((f) => f.value === form.form) ? [{ value: form.form, label: "The form it watched" }] : [])]}
                      onChange={(id) => patchTrigger({ form: id, ...(id ? {} : { job: "" }) })}
                    />
                  )}
                </Field>
              ) : null}
              {form.form ? null : (
                <Field label={forms?.length ? "Path" : "File"} hint="When someone else changes it">
                  <Input value={form.path} onChange={(e) => patchTrigger({ path: e.target.value })} placeholder="/Users/…/Travel budget.xlsx" spellCheck={false} autoComplete="off" className={MONO} />
                </Field>
              )}
            </>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <FieldRow label="Ends">
            <ChoiceToggle label="Ends" value={form.ends} options={ENDS} onChange={(ends) => patch({ ends })} />
          </FieldRow>
          {form.ends === "day" ? (
            <Field label="Ends on">
              <DateField required value={form.until} onChange={(until) => patch({ until })} />
            </Field>
          ) : null}
        </div>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter
        start={
          row && !row.proposed ? (
            <Button type="button" variant="ghost" disabled={pending || removing} onClick={() => void remove()}>
              <BusyLabel busy={removing} label="Delete" />
            </Button>
          ) : undefined
        }
        onCancel={onClose}
        confirmLabel={row === null ? "Create" : row.proposed ? "Add" : "Save"}
        pending={pending}
        busy={removing}
      />
    </form>
  );
}
