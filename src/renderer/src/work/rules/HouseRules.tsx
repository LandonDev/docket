import { useMemo, useState, type ReactNode } from "react";
import type { HouseRule, RuleProposal, RulesPage } from "@shared/contract-work-rules";
import { ChevronRight, GripVertical, Search } from "../../chrome/icons";
import { PageEmpty, PageRow, PageRowsSkeleton } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, DISCLOSURE_CHEVRON } from "../../components/ui/collapsible";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { reveal } from "../../components/ui/reveal";
import { loadToast } from "../../components/ui/toaster";
import { useSortable } from "../../hooks/useSortable";
import { cn } from "../../lib/cn";
import { workErrorWords } from "../../lib/workErrorWords";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { setWorkspaceSettings } from "../shell/actions";
import { lifeosHostName } from "../shell/lifeos";
import { downWords } from "../shell/lifeosDown";
import { useLiveDown } from "../shell/lifeosLive";
import { addRule, decideProposal, editRule, orderRules, removeRule, useRulesPage, useVoice } from "./data";
import { Evidence, fromEdits } from "./Evidence";
import { SaveMark } from "../../surfaces/settings/parts/SaveMark";
import { SettingRow, SettingSection } from "../../surfaces/settings/parts/SettingRow";
import { useSaved } from "../../surfaces/settings/parts/useSaved";
import { ReadFailure } from "../../surfaces/settings/parts/ReadFailure";
import { inWords } from "../../lib/settings/workWords";
import { RuleDialog, type RuleDialogOf, type RuleMoves } from "./RuleDialog";

/**
 * A job's house rules, on its settings page (docs/agents/work-rules.md "The screens", prototype rules.html): the rules
 * as one-line rows that open their edit dialog, a switch each, a grip in the gutter on hover to reorder, a find field
 * past twelve rules; then the proposals his edits made, each opening to the edits. The voice switch is a row of the
 * page's Writing and mail (`VoiceRow`). Every write is his press; a switch saves with the mark and a refusal puts it back
 * with the row's red line.
 */

/** Past this many rules, a find field sits over the list. */
const FIND_PAST = 12;

const failed = (what: string) => (err: unknown) => void loadToast().then((toast) => toast.error(what, { description: workErrorWords(err) || undefined }));

function Marked({ text, find }: { text: string; find: string }): ReactNode {
  if (!find) return text;
  const at = text.toLowerCase().indexOf(find.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[2px] bg-(--sel-bg) text-inherit">{text.slice(at, at + find.length)}</mark>
      {text.slice(at + find.length)}
    </>
  );
}

export function HouseRules({ workspace }: { workspace: WorkspaceMeta }) {
  const env = workspace.environmentId;
  const [load, put, again] = useRulesPage(env, workspace.id);
  const [dialog, setDialog] = useState<RuleDialogOf | null>(null);
  const page = load.status === "ready" ? load.value : null;

  // The edit dialog's Move up and Move down, written with its Save through the grip's reorder; a refusal stays in the dialog.
  const moves: RuleMoves | null = page
    ? {
        ids: page.rules.map((r) => r.id),
        save: (order) => reorder(env, workspace.id, page, put, order, true),
      }
    : null;

  const added = (rule: HouseRule): void =>
    void loadToast().then((toast) =>
      toast(`Added to ${workspace.name}'s rules`, { action: { label: "Undo", onClick: () => void removeRule(env, rule.id, true).catch(failed("Undo did not go through")) } }),
    );

  return (
    <>
      <SettingSection
        of="job.rules"
        action={
          <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "new" })}>
            Add rule…
          </Button>
        }
      >
        {load.status === "loading" ? <PageRowsSkeleton rows={3} control="switch" /> : null}
        {load.status === "error" ? <ReadFailure computer={env} error={load.error} retry={again.retry} /> : null}
        {page ? <RuleList env={env} workspaceId={workspace.id} page={page} put={put} onOpen={(rule) => setDialog({ kind: "rule", rule })} /> : null}
      </SettingSection>
      {page?.proposals.length ? (
        <SettingSection of="job.proposed">
          {page.proposals.map((p) => (
            <ProposalRow key={p.id} env={env} proposal={p} onAdded={added} onEdit={() => setDialog({ kind: "proposal", proposal: p })} />
          ))}
        </SettingSection>
      ) : null}
      {dialog ? <RuleDialog env={env} workspaceId={workspace.id} of={dialog} onClose={() => setDialog(null)} onAdded={dialog.kind === "proposal" ? added : undefined} moves={moves} /> : null}
    </>
  );
}

/**
 * The new order on screen at once, then on the host; refused, the old order
 * comes back and a toast says so (the grip), or the refusal goes to the
 * caller (`rethrow`: the dialog's Save, whose own line says it).
 */
function reorder(env: string, workspaceId: string, page: RulesPage, put: (p: RulesPage) => void, order: string[], rethrow = false): Promise<void> {
  const byId = new Map(page.rules.map((r) => [r.id, r]));
  put({ ...page, rules: order.map((id) => byId.get(id)!) });
  return orderRules(env, workspaceId, order).then(
    () => undefined,
    (err: unknown) => {
      put(page);
      if (rethrow) throw err;
      failed("The new order was not kept")(err);
    },
  );
}

function RuleList({ env, workspaceId, page, put, onOpen }: { env: string; workspaceId: string; page: RulesPage; put: (p: RulesPage) => void; onOpen: (rule: HouseRule) => void }) {
  const [find, setFind] = useState("");
  const q = find.trim();
  const shown = useMemo(() => (q ? page.rules.filter((r) => r.text.toLowerCase().includes(q.toLowerCase())) : page.rules), [page.rules, q]);
  const ids = useMemo(() => page.rules.map((r) => r.id), [page.rules]);
  const sortable = useSortable(ids, (order) => void reorder(env, workspaceId, page, put, order), "y");

  return (
    <>
      {page.rules.length > FIND_PAST ? (
        <InputGroup className="mb-1" leading={<Search className="size-4 text-muted-foreground" />}>
          <GroupInput value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a rule" aria-label="Find a rule" autoComplete="off" spellCheck={false} />
        </InputGroup>
      ) : null}
      {page.rules.length === 0 ? <PageEmpty>No rules yet</PageEmpty> : shown.length === 0 ? <PageEmpty>No rule says “{q}”</PageEmpty> : null}
      {shown.map((rule) => {
        const ix = ids.indexOf(rule.id);
        const dropping = !q && sortable.toIndex === ix && sortable.fromIndex !== null && sortable.toIndex !== sortable.fromIndex;
        return (
          <div key={rule.id} ref={(el) => sortable.setItemRef(rule.id, el)} data-rule={rule.id} className={cn("group/row relative border-t border-transparent [[data-rule]+&]:border-border", sortable.draggingId === rule.id && "z-10 [&_[data-slot=item]]:bg-muted")}>
            {dropping ? <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 z-20 h-0.5 rounded-full bg-accent", sortable.toIndex! < sortable.fromIndex! ? "-top-px" : "-bottom-px")} /> : null}
            {q ? null : (
              <span
                data-rule-grip
                aria-hidden
                onPointerDown={(event) => sortable.onItemPointerDown(rule.id, event)}
                className={cn(
                  "absolute top-1/2 -left-6.5 z-10 flex h-6 w-5 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground hover:text-foreground active:cursor-grabbing",
                  sortable.draggingId === rule.id ? "opacity-100" : reveal("row"),
                )}
              >
                <GripVertical className="size-3.5" />
              </span>
            )}
            <RuleRow env={env} rule={rule} find={q} onOpen={() => onOpen(rule)} />
          </div>
        );
      })}
    </>
  );
}

/** One rule: its words open its dialog; its switch saves with the mark, and a refusal puts it back with the row's red line. */
function RuleRow({ env, rule, find, onOpen }: { env: string; rule: HouseRule; find: string; onOpen: () => void }) {
  const saved = useSaved();
  return (
    <PageRow
      title={
        // An off rule keeps full ink: the switch says it is off, and the row can still be used.
        <span className="block min-w-0 truncate font-normal @max-[30rem]/page:line-clamp-2 @max-[30rem]/page:whitespace-normal">
          <Marked text={rule.text} find={find} />
        </span>
      }
      error={saved.error ?? undefined}
      onOpen={onOpen}
      openLabel={`Edit rule: ${rule.text}`}
      openTip={rule.text.length > 72 ? rule.text : undefined}
    >
      <SaveMark state={saved.state} />
      <SettingSwitch label={`Give threads the rule: ${rule.text}`} on={rule.on} onChange={(on) => saved.run(() => inWords(env, () => editRule(env, rule.id, { on })))} />
    </PageRow>
  );
}

function ProposalRow({ env, proposal, onAdded, onEdit }: { env: string; proposal: RuleProposal; onAdded: (rule: HouseRule) => void; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"add" | "dismiss" | null>(null);
  const add = (): void => {
    setBusy("add");
    addRule(env, proposal.workspaceId, proposal.text, proposal.id).then(onAdded, failed("The rule was not added")).finally(() => setBusy(null));
  };
  const dismiss = (): void => {
    setBusy("dismiss");
    decideProposal(env, proposal.id, "dismissed")
      .then(
        () =>
          void loadToast().then((toast) =>
            toast("Dismissed", { action: { label: "Undo", onClick: () => void decideProposal(env, proposal.id, "open").catch(failed("Undo did not go through")) } }),
          ),
        failed("The proposal was not dismissed"),
      )
      .finally(() => setBusy(null));
  };
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="page-row" data-proposal={proposal.id} className="border-t border-transparent py-3 [[data-slot=page-row]+&]:border-border">
      <div className="flex items-start gap-3">
        <CollapsibleTrigger className="group/d flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm text-start">
          <span className="text-[13px] leading-5 text-foreground">{proposal.text}</span>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground group-hover/d:text-foreground">
            {fromEdits(proposal.edits.length)}
            <ChevronRight className={cn("size-3", DISCLOSURE_CHEVRON, open && "rotate-90")} />
          </span>
        </CollapsibleTrigger>
        <span className="flex shrink-0 gap-2">
          <Button variant="ghost" size="xs" disabled={busy !== null} onClick={dismiss}>
            <BusyLabel busy={busy === "dismiss"} label="Dismiss" />
          </Button>
          <Button variant="secondary" size="xs" disabled={busy !== null} onClick={add}>
            <BusyLabel busy={busy === "add"} label="Add" />
          </Button>
        </span>
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 pt-3">
          <Evidence edits={proposal.edits} />
          <Button variant="ghost" size="xs" className="-ms-2 self-start" onClick={onEdit}>
            Edit before adding…
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/**
 * Learn how I write from my sent mail: a row of the job page's Writing and mail, shown only where the job has a sector
 * to read mail from and this key may write the job's settings. It saves with the mark; a refusal puts it back.
 */
export function VoiceRow({ workspace }: { workspace: WorkspaceMeta }) {
  const [facts, put, again] = useVoice(workspace.environmentId, workspace.id);
  const saved = useSaved();
  const flip = (voice: boolean): Promise<boolean> =>
    saved.run(() =>
      inWords(workspace.environmentId, async () => {
        await setWorkspaceSettings(workspace, { voice });
        if (facts.status === "ready") put({ ...facts.value, on: voice });
      }),
    );
  const v = facts.status === "ready" ? facts.value : null;
  // While the host's LifeOS is down the row is quiet: the page says the state once, at the unanswered row, with its
  // press; the switch stays, a job setting. The count is read again once the host is back. A read of a connected
  // session that failed is LifeOS's silence, its computer named.
  const quiet = useLiveDown(null, workspace.environmentId, again.retry);
  const down = !!quiet.down || quiet.waits;
  const error = !down && v?.error ? downWords("unreachable", lifeosHostName(workspace.environmentId)) : undefined;
  const line =
    down || !v || v.count === null
      ? undefined
      : v.count === 0
        ? "No mail sent in the last 30 days"
        : `${v.count} ${v.count === 1 ? "mail" : "mails"}${v.from[0] ? ` from ${v.from[0]}` : ""} since ${DAY.format(v.since ?? Date.now())}`;
  if (facts.status === "loading") return <PageRowsSkeleton rows={1} description control="switch" />;
  if (facts.status === "error") return <ReadFailure computer={workspace.environmentId} error={facts.error} retry={again.retry} />;
  return (
    <SettingRow
      id="job.voice"
      saved={saved}
      description={line}
      error={
        error ? (
          // LifeOS's silence: Retry reads the count again, spinning in place until the answer replaces the line.
          <span data-voice-failed className="inline-flex flex-wrap items-center gap-x-2">
            {error}
            <Button variant="ghost" size="xs" className="-my-1" disabled={again.retrying} onClick={again.retry}>
              <BusyLabel busy={again.retrying} label="Retry" />
            </Button>
          </span>
        ) : undefined
      }
    >
      <SettingSwitch label="Learn how I write from my sent mail" on={facts.value.on} onChange={flip} />
    </SettingRow>
  );
}
