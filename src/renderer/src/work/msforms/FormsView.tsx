import { HostLinkLine, useHostLinkDown } from "../shell/hostLinkDown";
import { useLinkMay } from "../../lib/linkMay";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import type { FolderRef } from "@shared/work/files";
import type { FormListRow, MsFormView } from "@shared/contract-work-msforms";
import { Plus } from "../../chrome/icons";
import { RowsContextMenu, RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { confirmAction } from "../../chrome/ConfirmDialog";
import { ItemButton } from "../../components/ui/item";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { registry } from "../../lib/connection";
import { dayTime } from "../../lib/duration";
import { shell } from "../../stores/shell";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { sayError } from "../canvas/frame";
import { openInFiles } from "../files/openFrom";
import { selectTab, tabsNow } from "../files/store";
import { openWorkView, workOpenPort } from "../../lib/workSwitch";
import type { WorkViewProps } from "../views/registry";
import { mergeForms, rowLine } from "./model";
import { FORM_KIND_WORDS } from "./newForm";
import { useFormMaking, useLibraryPlaces } from "./useFormMaking";

/**
 * A Work workspace's Forms (docs/agents/work-msforms.md "Forms view"): one list of the job's forms, ours and
 * Microsoft's, newest first. A row opens its form: a Microsoft form in a Files tab of its own, ours where it lives
 * (its Files tab, or the thread that made it). New in the header makes either kind; a Microsoft form is made in a
 * Teams or OneDrive place he picks there.
 */

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; rows: FormListRow[]; ms: MsFormView[]; missed: string | null };

/** An older host may lack a source. A refusal from a source it has still counts as a failed read. */
function formSource<T>(request: Promise<T>): Promise<T | null> {
  return request.catch((error: unknown) => {
    if (error instanceof Error && /^(?:unknown method|no such method|unsupported method)\b/i.test(error.message)) return null;
    throw error;
  });
}

const listeners = new Set<() => void>();
/** Something changed the list (a make): every mounted list reads again. */
const changed = (): void => listeners.forEach((l) => l());

function useForms(env: string, workspaceId: string): [Load, () => void, () => Promise<void>] {
  const canReadOurs = useLinkMay(env, "work.forms.list", { workspaceId });
  const canReadMs = useLinkMay(env, "work.msforms.list", { workspaceId });
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const again = useCallback(() => setTick((t) => t + 1), []);
  // The read the effect holds, for Retry: the failure stays until it answers.
  const read = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    listeners.add(again);
    return () => void listeners.delete(again);
  }, [again]);
  useEffect(() => {
    let on = true;
    const link = registry.linkOf(env);
    let latest: symbol;
    const fetch = async (): Promise<void> => {
      const mine = Symbol();
      latest = mine;
      const ours = canReadOurs ? formSource(link.request<FormListRow[]>("work.forms.list", { workspaceId })) : Promise.resolve(null);
      const theirs = canReadMs ? formSource(link.request<{ forms: MsFormView[] }>("work.msforms.list", { workspaceId })).then((r) => r?.forms ?? null) : Promise.resolve(null);
      const [o, m] = await Promise.allSettled([ours, theirs]);
      if (!on || mine !== latest) return;
      const haveAnswer = (o.status === "fulfilled" && o.value !== null) || (m.status === "fulfilled" && m.value !== null);
      if (!haveAnswer && (o.status === "rejected" || m.status === "rejected")) return setLoad({ status: "error" });
      const ms = (m.status === "fulfilled" ? m.value : null) ?? [];
      const missed = o.status === "rejected" ? "Docket forms did not load" : m.status === "rejected" ? "Microsoft forms did not load" : null;
      setLoad({ status: "ready", rows: mergeForms((o.status === "fulfilled" ? o.value : null) ?? [], ms), ms, missed });
    };
    read.current = fetch;
    void fetch();
    // A form's own change (a count, a state) moves its row.
    const off = link.onPush((push) => {
      if (push.push === "work.msforms" && push.workspaceId === workspaceId) again();
    });
    const offOpen = link.onOpen(() => void fetch());
    return () => {
      offOpen();
      on = false;
      off();
    };
  }, [env, workspaceId, tick, again, canReadOurs, canReadMs]);
  return [load, again, useCallback(() => read.current(), [])];
}

export function Head({ env, workspace }: WorkViewProps) {
  const linkDown = useHostLinkDown(env);
  const { offered, making, stage, make } = useFormMaking(workspace);
  const places = useLibraryPlaces(env, workspace.id, offered) ?? [];
  const ms: MenuRow[] = offered && places.length ? [{ kind: "sub", id: "ms", label: FORM_KIND_WORDS.microsoft.label, items: places.map((p): MenuRow => ({ kind: "item", id: `in:${p.id}`, label: p.group && p.group !== p.name ? `${p.group}, ${p.name}` : p.name })) }] : [];
  const rows: MenuRow[] = [...ms, { kind: "item", id: "ours", label: FORM_KIND_WORDS.tempcode.label, description: ms.length ? FORM_KIND_WORDS.tempcode.line : undefined }];
  const pick = (id: string): void => {
    if (linkDown) return;
    if (id === "ours") return void make("tempcode", null).then(() => openWorkView({ workspaceId: workspace.id, view: "files" }));
    const place = places.find((p) => id === `in:${p.id}`);
    if (place) void make("microsoft", place.root as FolderRef).then(() => (changed(), openWorkView({ workspaceId: workspace.id, view: "files" })));
  };
  return (
    <RowsMenu
      label="New"
      align="end"
      rows={rows}
      onPick={pick}
      trigger={<NewFormPress making={making} stage={stage} disabled={!!linkDown} />}
    />
  );
}

/** New form, the header's press. A Microsoft form takes 20 to 45 s: the press says each stage as the host starts it, as Files' state line does. */
export function NewFormPress({ making, stage, disabled = false, ...props }: { making: boolean; stage: string | null; disabled?: boolean } & ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="sm" {...props} disabled={making || disabled}>
      {making ? null : <Plus />}
      <BusyLabel busy={making} label="New form" busyLabel={stage ?? undefined} />
    </Button>
  );
}

export function View({ env, workspace }: WorkViewProps) {
  const [load, retry, readAgain] = useForms(env, workspace.id);
  const linkDown = useHostLinkDown(env);
  // His Retry spins in place, the failure kept, until the read answers.
  const [retrying, setRetrying] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  if (linkDown) return <HostLinkLine word={linkDown} retryHost={env} />;
  if (load.status === "loading") return <FormsSkeleton />;
  if (load.status === "error")
    return (
      <EmptyState
        title="Forms did not load"
        action={{
          label: "Retry",
          busy: retrying,
          onClick: () => {
            setRetrying(true);
            void readAgain().finally(() => setRetrying(false));
          },
        }}
      />
    );
  if (!load.rows.length && !load.missed) return <EmptyState title="No forms yet" />;

  const open = (row: FormListRow): void => {
    if (row.kind === "ms") {
      const form = load.ms.find((f) => f.formId === row.id);
      if (!form) return;
      setOpening(row.id);
      void openInFiles(workspace, { ref: { at: "msform", host: env, workspaceId: workspace.id, formId: form.formId, tenant: form.tenant }, name: form.title })
        // A form gone since the list was read: it falls back to the list, read again.
        .catch((err: unknown) => (sayError(err, "Couldn't open the form"), retry()))
        .finally(() => setOpening(null));
      return;
    }
    // Ours lives in its Files tab, or in the thread that made it.
    const tab = tabsNow(env, workspace.id).find((t) => t.itemId === row.id);
    if (tab) {
      selectTab(env, workspace.id, tab.id);
      return openWorkView({ workspaceId: workspace.id, view: "files" });
    }
    if (row.sessionId) {
      shell.closeViews();
      workOpenPort.get()?.(row.sessionId);
    }
  };

  // A Microsoft form's row can leave the list on his press: Forms keeps the form as it is.
  const forget = async (id: string): Promise<void> => {
    const form = load.ms.find((f) => f.formId === id);
    if (!form) return;
    if (!(await confirmAction({ title: `Remove “${form.title}” from the list?`, body: "It stays in Microsoft Forms.", action: "Remove" }))) return;
    await registry
      .linkOf(env)
      .request("work.msforms.forget", { workspaceId: workspace.id, formId: id })
      .then(retry, (err: unknown) => sayError(err, "Couldn't remove the form from the list"));
  };

  return (
    <div className="h-full min-h-0 overflow-x-hidden overflow-y-auto">
      {load.missed ? <p role="status" className="mx-auto max-w-[672px] px-4 pt-3 text-[13px] text-muted-foreground">{load.missed}</p> : null}
      <RowsContextMenu label="Form actions" lazyMount rowsFor={(id) => (id && load.ms.some((f) => f.formId === id) ? [{ kind: "item", id: "forget", label: "Remove from List" }] : null)} onPick={(pick, id) => void (pick === "forget" && id && forget(id))}>
        <ul aria-label="Forms" className="mx-auto flex max-w-[672px] flex-col gap-px px-4 py-4">
          {load.rows.map((row) => (
            <Row key={`${row.kind}:${row.id}`} row={row} busy={opening === row.id} onPress={() => open(row)} />
          ))}
        </ul>
      </RowsContextMenu>
    </div>
  );
}

function Row({ row, busy, onPress }: { row: FormListRow; busy: boolean; onPress(): void }) {
  const words = (
    <>
      <span className="truncate text-[13px] font-medium text-foreground">{row.title}</span>
      <span className="truncate text-xs text-muted-foreground tabular-nums">{rowLine(row, dayTime)}</span>
    </>
  );
  const shape = "flex-col flex-nowrap items-stretch gap-0.5 px-2 py-1.5 pr-20";
  return (
    <li data-forms-row {...(row.kind === "ms" ? { "data-menu-id": row.id } : {})} className="relative flex flex-col">
      <ItemButton onClick={onPress} className={shape}>
        {words}
      </ItemButton>
      {busy ? (
        <span className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner aria-hidden className="size-3" />
          Opening…
        </span>
      ) : null}
    </li>
  );
}

function FormsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading forms" className="mx-auto flex max-w-[672px] flex-col gap-3 px-6 py-5">
      {[44, 58, 36].map((w, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
          <Skeleton className="h-3" style={{ width: `${w - 14}%` }} />
        </div>
      ))}
    </div>
  );
}

