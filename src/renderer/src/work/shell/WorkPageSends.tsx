import { useCallback, useEffect, useState } from "react";
import type { ToolRuleRow, ToolRulesCard } from "@shared/contract-work-outbox";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { ChoiceSelect } from "../../components/choice-select";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { useEnvironments } from "../../lib/connection";
import { withDeadline } from "../../lib/connection/openRead";
import { useLinksMay } from "../../lib/linkMay";
import { hostFailure } from "../../lib/hostFailure";
import { computerInLine, useComputerNames } from "../../lib/settings/computerName";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { useWorkHosts } from "../../lib/workSwitch";
import { ListFilter, useListFilter, filterList, LIST_FILTER_PAST } from "../../surfaces/settings/parts/ListFilter";
import { ManagedLine } from "../../surfaces/settings/parts/ManagedLine";
import { SaveMark } from "../../surfaces/settings/parts/SaveMark";
import { SettingRow } from "../../surfaces/settings/parts/SettingRow";
import { hostRequest } from "../../surfaces/settings/parts/hostRpc";
import { useSaved } from "../../surfaces/settings/parts/useSaved";
import { grantLine, WORK_CHATS_KEY } from "../outbox/model";
import { removeGrant, useOutbox, useOutboxPage, type HostGrant } from "../outbox/store";

/**
 * What Work threads may do without his press (docs/agents/settings.md "The pages: Work"): the standing send grants,
 * read from the Outbox's store and removed through it (work/outbox/store.ts, unchanged), and each add-on's tools,
 * `work.outbox.rules` and `work.outbox.setRules`, the control the phone had alone. Each row is one computer's: a
 * press writes the computer that holds it and no other.
 */

/** How a grant is made, said in the sheet and in its empty state alike. */
export const GRANTS_MADE = "Made from a held item in the Outbox, under More ways to send.";

/** "6 across 3 jobs", "2 for Purdue Esports", "None". */
export function grantsWords(grants: readonly Pick<HostGrant, "environmentId" | "workspaceId">[], jobName: (workspaceId: string) => string): string {
  if (grants.length === 0) return "None";
  const jobs = new Set(grants.map((g) => `${g.environmentId}:${g.workspaceId}`));
  if (jobs.size === 1) return `${grants.length} for ${jobName(grants[0]!.workspaceId)}`;
  return `${grants.length} across ${jobs.size} jobs`;
}

/** The open row to the grants sheet: one sheet, opened from Work and from Mail alike. */
export function GrantsRow({ id }: { id: "work.grants" | "mail.grants" }) {
  useOutboxPage();
  const view = useOutbox();
  const jobName = useGrantJobName();
  const [open, setOpen] = useState(false);
  // Until every computer with Work on has answered, the count would be a guess: it waits.
  const description = view.loaded ? grantsWords(view.grants, jobName) : undefined;
  return (
    <>
      <SettingRow id={id} description={description} onOpen={() => setOpen(true)} openLabel="Things threads may send on their own" />
      <StoreGrantsSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

/** A grant's job by its workspace's name; Work Chats' own grants by that name. */
function useGrantJobName(): (workspaceId: string) => string {
  const workspaces = useWorkspaces();
  return useCallback((workspaceId: string) => (workspaceId === WORK_CHATS_KEY ? "Work Chats" : (workspaces.find((w) => w.id === workspaceId)?.name ?? "a job")), [workspaces]);
}

/** The sheet over the Outbox's store: every computer with Work on, each grant removed from the computer that holds it. */
export function StoreGrantsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  useOutboxPage();
  const view = useOutbox();
  const jobName = useGrantJobName();
  return <GrantsSheet open={open} onOpenChange={onOpenChange} grants={view.grants} loaded={view.loaded} errors={view.errors} jobName={jobName} />;
}

const grantWords = (grant: HostGrant, job: string): string => `${grant.label} ${job}`;

export function GrantsSheet({
  open,
  onOpenChange,
  grants,
  loaded,
  errors,
  jobName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grants: readonly HostGrant[];
  loaded: boolean;
  errors: readonly { environmentId: string; error: string }[];
  jobName: (workspaceId: string) => string;
}) {
  const may = useLinksMay();
  const names = useComputerNames();
  const workspaces = useWorkspaces();
  const words = useCallback((grant: HostGrant) => grantWords(grant, jobName(grant.workspaceId)), [jobName]);
  const filter = useListFilter(grants, words);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = async (grant: HostGrant): Promise<void> => {
    setBusy(grant.id);
    setError(null);
    try {
      await removeGrant(grant);
    } catch (err) {
      setError(hostFailure(grant.environmentId, err, "did not remove the grant", true));
    }
    setBusy(null);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" data-grants-sheet="">
        <SheetHeader>
          <SheetTitle>Things threads may send on their own</SheetTitle>
          {grants.length ? <SheetDescription className="text-xs">{GRANTS_MADE}</SheetDescription> : null}
        </SheetHeader>
        <div className="@container/page flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-5 pb-5">
          <ListFilter filter={filter} label="Find a grant" />
          {errors.map((e) => (
            <PageError key={e.environmentId}>{`${capital(computerInLine(names(e.environmentId)))} did not answer.`}</PageError>
          ))}
          {!loaded && grants.length === 0 && errors.length === 0 ? (
            <PageRowsSkeleton rows={3} description control="button" />
          ) : grants.length === 0 && errors.length === 0 ? (
            <PageEmpty>{`None yet. ${GRANTS_MADE}`}</PageEmpty>
          ) : (
            filter.shown.map((grant) => {
              const job = workspaces.find((w) => w.id === grant.workspaceId);
              return (
                <PageRow
                  key={`${grant.environmentId}:${grant.id}`}
                  data-grant={grant.id}
                  media={<SectorDot sector={job?.sector ?? null} />}
                  title={<span className="break-words">{grant.label}</span>}
                  description={`${jobName(grant.workspaceId)}. ${grantLine(grant.kind, grant.createdAt)}`}
                >
                  {may(grant.environmentId, "work.outbox.ungrant") ? (
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void remove(grant)}>
                      <BusyLabel busy={busy === grant.id} label="Remove" />
                    </Button>
                  ) : null}
                </PageRow>
              );
            })
          )}
          {error ? <PageError>{error}</PageError> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// ── each add-on's tools ─────────────────────────────────────────────

export type ToolRule = NonNullable<ToolRuleRow["rule"]>;
const RULES: { value: ToolRule; label: string }[] = [
  { value: "runs", label: "Runs" },
  { value: "held", label: "Waits for you" },
  { value: "off", label: "Off" },
];
const NOT_SET = "unset";
export const ruleLabel = (rule: ToolRule | null): string => RULES.find((r) => r.value === rule)?.label ?? "Not set";

export function ToolsRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingRow id="work.tools" description="Each tool runs, waits for you, or is off" onOpen={() => setOpen(true)} openLabel="What each add-on's tools may do" />
      <ToolsSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

type HostCards = { cards?: ToolRulesCard[]; error?: string };

/** Each computer with Work on, asked for its add-ons' tools while the sheet is open. */
function useToolCards(open: boolean, hosts: readonly string[]) {
  const [byHost, setByHost] = useState<Record<string, HostCards>>({});
  const [attempt, setAttempt] = useState(0);
  const key = hosts.join(",");
  useEffect(() => {
    if (!open) return;
    let live = true;
    for (const id of hosts)
      withDeadline(hostRequest<{ addons: ToolRulesCard[] }>(id, "work.outbox.rules", {})).then(
        (answer) => live && setByHost((was) => ({ ...was, [id]: { cards: answer.addons } })),
        (err: unknown) => live && setByHost((was) => ({ ...was, [id]: { ...was[id], error: hostFailure(id, err, "did not list its add-ons' tools") } })),
      );
    return () => {
      live = false;
    };
  }, [open, key, attempt]);
  const put = (id: string, card: ToolRulesCard): void =>
    setByHost((was) => ({ ...was, [id]: { cards: (was[id]?.cards ?? []).map((c) => (c.addonId === card.addonId ? card : c)) } }));
  return { byHost, put, retry: () => setAttempt((n) => n + 1) };
}

export function ToolsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const on = useWorkHosts();
  const hosts = useEnvironments()
    .map((e) => e.id)
    .filter((id) => on.has(id));
  const { byHost, put, retry } = useToolCards(open, hosts);
  const names = useComputerNames();
  const may = useLinksMay();
  const [query, setQuery] = useState("");
  // The add-ons LifeOS's own row stands for are never his to set.
  const cardsOf = (id: string): ToolRulesCard[] => (byHost[id]?.cards ?? []).filter((card) => !card.lifeos);
  const total = hosts.reduce((n, id) => n + cardsOf(id).reduce((m, card) => m + card.tools.length, 0), 0);
  const findable = total > LIST_FILTER_PAST;
  const matching = (card: ToolRulesCard): ToolRuleRow[] => [...filterList(card.tools, (t) => `${t.words} ${card.name}`, findable ? query : "")];
  const matched = hosts.reduce((n, id) => n + cardsOf(id).reduce((m, card) => m + matching(card).length, 0), 0);
  const several = hosts.filter((id) => cardsOf(id).length > 0).length > 1;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" data-tools-sheet="">
        <SheetHeader>
          <SheetTitle>What each add-on's tools may do</SheetTitle>
        </SheetHeader>
        <div className="@container/page flex min-h-0 flex-1 flex-col gap-6 overflow-x-hidden overflow-y-auto px-5 pb-5">
          {findable ? (
            <ListFilter filter={{ shown: Array.from({ length: matched }), query, setQuery, offered: true }} label="Find a tool" />
          ) : null}
          {hosts.map((id) => {
            const read = byHost[id];
            const where = several ? ` on ${computerInLine(names(id))}` : "";
            if (!read?.cards) {
              return read?.error ? (
                <PageError
                  key={id}
                  action={
                    <Button variant="ghost" size="sm" onClick={retry}>
                      Retry
                    </Button>
                  }
                >
                  {read.error}
                </PageError>
              ) : (
                <PageRowsSkeleton key={id} rows={3} control="select" />
              );
            }
            const cards = cardsOf(id);
            if (cards.length === 0) return hosts.length > 1 ? null : <PageEmpty key={id}>No add-on reaches Work threads</PageEmpty>;
            const mayWrite = may(id, "work.outbox.setRules");
            return (
              <div key={id} className="flex flex-col gap-6">
                {mayWrite ? null : <ManagedLine computer={names(id).name} />}
                {cards.map((card) => {
                  const tools = matching(card);
                  if (tools.length === 0) return null;
                  return (
                    <PageSection key={card.addonId} title={`${card.name}${where}`} data-addon={card.addonId}>
                      {tools.map((tool) => (
                        <ToolRow key={tool.tool} environmentId={id} card={card} tool={tool} mayWrite={mayWrite} onCard={(next) => put(id, next)} />
                      ))}
                    </PageSection>
                  );
                })}
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** One tool's rule: the select moves at once and goes back if its computer refuses. */
function ToolRow({ environmentId, card, tool, mayWrite, onCard }: { environmentId: string; card: ToolRulesCard; tool: ToolRuleRow; mayWrite: boolean; onCard: (card: ToolRulesCard) => void }) {
  const saved = useSaved();
  const [shown, setShown] = useState<ToolRule | null>(null);
  const value = shown ?? tool.rule;
  const change = async (next: ToolRule): Promise<void> => {
    setShown(next);
    // Taken, the card the computer sends back holds the rule; refused, the select goes back to the rule it holds.
    await saved.run(async () =>
      onCard(
        await hostRequest<ToolRulesCard>(environmentId, "work.outbox.setRules", { addonId: card.addonId, rules: { [tool.tool]: next } }).catch((err: unknown) => {
          throw new Error(hostFailure(environmentId, err, "did not save the rule", true));
        }),
      ),
    );
    setShown(null);
  };
  return (
    <PageRow data-tool={tool.tool} title={tool.words} description={tool.changed ? "Changed since you set it" : undefined} error={saved.error}>
      {mayWrite ? (
        <>
          <SaveMark state={saved.state} />
          <ChoiceSelect
            size="sm"
            label={tool.words}
            value={value ?? NOT_SET}
            options={value ? RULES : [{ value: NOT_SET, label: "Not set" }, ...RULES]}
            onChange={(next) => {
              if (next !== NOT_SET) void change(next as ToolRule);
            }}
          />
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{ruleLabel(value)}</span>
      )}
    </PageRow>
  );
}
