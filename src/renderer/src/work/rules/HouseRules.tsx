import { useMemo, useState, type ReactNode } from "react";
import type { HouseRule, RuleProposal, RulesPage } from "@shared/contract-work-rules";
import { ChevronRight, GripVertical, Search } from "../../chrome/icons";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, DISCLOSURE_CHEVRON } from "../../components/ui/collapsible";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { reveal } from "../../components/ui/reveal";
import { loadToast } from "../../components/ui/toaster";
import { useSortable } from "../../hooks/useSortable";
import { cn } from "../../lib/cn";
import { refusalWords } from "../../lib/settingsHome";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { setWorkspaceSettings } from "../shell/actions";
import { addRule, decideProposal, editRule, orderRules, removeRule, useRulesPage, useVoice } from "./data";
import { Evidence, fromEdits } from "./Evidence";
import { RuleDialog, type RuleDialogOf } from "./RuleDialog";

/**
 * A Work workspace's house rules, on its settings page
 * (docs/agents/work-rules.md "The screens", prototype rules.html): the rules
 * as one-line rows that open their edit dialog, a switch each, a grip in the
 * gutter on hover to reorder, a find field past twelve rules; then the
 * proposals his edits made, each opening to the edits; then the voice
 * switch, only where the workspace has a sector to read mail from. Every
 * write is his press.
 */

/** Past this many rules, a find field sits over the list. */
const FIND_PAST = 12;

const failed = (what: string) => (err: unknown) => void loadToast().then((toast) => toast.error(what, { description: refusalWords(err) || undefined }));

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
  const [load, put] = useRulesPage(env, workspace.id);
  const [dialog, setDialog] = useState<RuleDialogOf | null>(null);
  const page = load.status === "ready" ? load.value : null;

  // The edit dialog's Move up and Move down: the grip's reorder, kept in step with the list.
  const ruleId = dialog?.kind === "rule" ? dialog.rule.id : null;
  const at = page && ruleId ? page.rules.findIndex((r) => r.id === ruleId) : -1;
  const moves =
    page && at >= 0
      ? {
          at,
          of: page.rules.length,
          move: (by: -1 | 1) => {
            const order = page.rules.map((r) => r.id);
            const to = at + by;
            if (to < 0 || to >= order.length) return Promise.resolve();
            [order[at], order[to]] = [order[to]!, order[at]!];
            return reorder(env, workspace.id, page, put, order);
          },
        }
      : null;

  const added = (rule: HouseRule): void =>
    void loadToast().then((toast) =>
      toast(`Added to ${workspace.name}'s rules`, { action: { label: "Undo", onClick: () => void removeRule(env, rule.id, true).catch(failed("Undo did not go through")) } }),
    );

  return (
    <>
      <PageSection
        title="House rules"
        action={
          <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "new" })}>
            Add rule…
          </Button>
        }
      >
        {load.status === "loading" ? <PageRowsSkeleton rows={3} control="switch" /> : null}
        {load.status === "error" ? <PageError>{load.error}</PageError> : null}
        {page ? <RuleList env={env} workspaceId={workspace.id} page={page} put={put} onOpen={(rule) => setDialog({ kind: "rule", rule })} /> : null}
      </PageSection>
      {page?.proposals.length ? (
        <PageSection title="Proposed">
          {page.proposals.map((p) => (
            <ProposalRow key={p.id} env={env} proposal={p} onAdded={added} onEdit={() => setDialog({ kind: "proposal", proposal: p })} />
          ))}
        </PageSection>
      ) : null}
      {workspace.sector ? <Voice workspace={workspace} /> : null}
      {dialog ? <RuleDialog env={env} workspaceId={workspace.id} of={dialog} onClose={() => setDialog(null)} onAdded={dialog.kind === "proposal" ? added : undefined} moves={moves} /> : null}
    </>
  );
}

/** The new order on screen at once, then on the host; refused, the old order comes back and a toast says so. */
function reorder(env: string, workspaceId: string, page: RulesPage, put: (p: RulesPage) => void, order: string[]): Promise<void> {
  const byId = new Map(page.rules.map((r) => [r.id, r]));
  put({ ...page, rules: order.map((id) => byId.get(id)!) });
  return orderRules(env, workspaceId, order).then(
    () => undefined,
    (err: unknown) => {
      put(page);
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
  const flip = async (rule: HouseRule, on: boolean): Promise<boolean> => {
    try {
      await editRule(env, rule.id, { on });
      return true;
    } catch (err) {
      failed(on ? "The rule was not turned on" : "The rule was not turned off")(err);
      return false;
    }
  };

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
            <PageRow
              title={
                <span className={cn("block min-w-0 truncate font-normal @max-[30rem]/page:line-clamp-2 @max-[30rem]/page:whitespace-normal", !rule.on && "text-muted-foreground")}>
                  <Marked text={rule.text} find={q} />
                </span>
              }
              onOpen={() => onOpen(rule)}
              openLabel={`Edit rule: ${rule.text}`}
              openTip={rule.text.length > 72 ? rule.text : undefined}
            >
              <SettingSwitch label={`Give threads the rule: ${rule.text}`} on={rule.on} onChange={(on) => flip(rule, on)} />
            </PageRow>
          </div>
        );
      })}
    </>
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

function Voice({ workspace }: { workspace: WorkspaceMeta }) {
  const [facts, put] = useVoice(workspace.environmentId, workspace.id);
  const flip = async (voice: boolean): Promise<boolean> => {
    try {
      await setWorkspaceSettings(workspace, { voice });
      if (facts.status === "ready") put({ ...facts.value, on: voice });
      return true;
    } catch (err) {
      failed("The voice switch did not change")(err);
      return false;
    }
  };
  const v = facts.status === "ready" ? facts.value : null;
  const line =
    !v || v.count === null
      ? undefined
      : v.count === 0
        ? "No mail sent in the last 30 days"
        : `${v.count} ${v.count === 1 ? "mail" : "mails"}${v.from[0] ? ` from ${v.from[0]}` : ""} since ${DAY.format(v.since ?? Date.now())}`;
  return (
    <PageSection title="Voice">
      {facts.status === "loading" ? (
        <PageRowsSkeleton rows={1} description control="switch" />
      ) : facts.status === "error" ? (
        <PageError>{facts.error}</PageError>
      ) : (
        <PageRow title="Read my sent mail for how I write" description={line} error={facts.value.error}>
          <SettingSwitch label="Read my sent mail for how I write" on={facts.value.on} onChange={flip} />
        </PageRow>
      )}
    </PageSection>
  );
}
