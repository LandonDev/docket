import { useCallback, useEffect, useState } from "react";
import type { FilePlace, FolderRef } from "@shared/work/files";
import type { FilesPlaces } from "@shared/contract-work-files";
import type { FormListRow, MsFormView } from "@shared/contract-work-msforms";
import { Plus } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
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
import { useFormMaking } from "./useFormMaking";

/**
 * A Work workspace's Forms (docs/agents/work-msforms.md "Forms view"): one list of the job's forms, ours and
 * Microsoft's, newest first. A row opens its form: a Microsoft form in a Files tab of its own, ours where it lives
 * (its Files tab, or the thread that made it). New in the header makes either kind; a Microsoft form is made in a
 * Teams or OneDrive place he picks there.
 */

type Load = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; rows: FormListRow[]; ms: MsFormView[] };

const listeners = new Set<() => void>();
/** Something changed the list (a make): every mounted list reads again. */
const changed = (): void => listeners.forEach((l) => l());

function useForms(env: string, workspaceId: string): [Load, () => void] {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const again = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    listeners.add(again);
    return () => void listeners.delete(again);
  }, [again]);
  useEffect(() => {
    let on = true;
    const link = registry.linkOf(env);
    const ours = link.request<FormListRow[]>("work.forms.list", { workspaceId }).catch(() => [] as FormListRow[]);
    const theirs = link.request<{ forms: MsFormView[] }>("work.msforms.list", { workspaceId }).then(
      (r) => r.forms,
      () => [] as MsFormView[],
    );
    void Promise.all([ours, theirs]).then(
      ([o, m]) => on && setLoad({ status: "ready", rows: mergeForms(o, m), ms: m }),
      (err: unknown) => on && setLoad({ status: "error", error: err instanceof Error ? err.message : "The forms could not be read." }),
    );
    // A form's own change (a count, a state) moves its row.
    const off = link.onPush((push) => {
      if (push.push === "work.msforms" && push.workspaceId === workspaceId) again();
    });
    return () => {
      on = false;
      off();
    };
  }, [env, workspaceId, tick, again]);
  return [load, again];
}

/** The Teams and OneDrive places a Microsoft form may be made in, read when New opens. */
function useLibraryPlaces(env: string, workspaceId: string, want: boolean): FilePlace[] {
  const [places, setPlaces] = useState<FilePlace[]>([]);
  useEffect(() => {
    if (!want) return;
    let on = true;
    void registry
      .linkOf(env)
      .request<FilesPlaces>("work.files.places", { workspaceId })
      .then(
        (r) => on && setPlaces(r.places.filter((p) => (p.kind === "teams" || p.kind === "onedrive") && p.root.at === "file")),
        () => undefined,
      );
    return () => {
      on = false;
    };
  }, [env, workspaceId, want]);
  return places;
}

export function Head({ env, workspace }: WorkViewProps) {
  const { offered, making, make } = useFormMaking(workspace);
  const places = useLibraryPlaces(env, workspace.id, offered);
  const ms: MenuRow[] = offered && places.length ? [{ kind: "sub", id: "ms", label: FORM_KIND_WORDS.microsoft.label, items: places.map((p): MenuRow => ({ kind: "item", id: `in:${p.id}`, label: p.group && p.group !== p.name ? `${p.group}, ${p.name}` : p.name })) }] : [];
  const rows: MenuRow[] = [...ms, { kind: "item", id: "ours", label: FORM_KIND_WORDS.tempcode.label, description: ms.length ? FORM_KIND_WORDS.tempcode.line : undefined }];
  const pick = (id: string): void => {
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
      trigger={
        <Button variant="ghost" size="sm" disabled={making}>
          {making ? null : <Plus />}
          <BusyLabel busy={making} label="New form" />
        </Button>
      }
    />
  );
}

export function View({ env, workspace }: WorkViewProps) {
  const [load, retry] = useForms(env, workspace.id);
  const [opening, setOpening] = useState<string | null>(null);
  if (load.status === "loading") return <FormsSkeleton />;
  if (load.status === "error") return <EmptyState title="Forms did not load" line={load.error} action={{ label: "Retry", onClick: retry }} />;
  if (!load.rows.length) return <EmptyState title="No forms yet" />;

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

  return (
    <div className="h-full min-h-0 overflow-x-hidden overflow-y-auto">
      <ul aria-label="Forms" className="mx-auto flex max-w-[672px] flex-col gap-px px-4 py-4">
        {load.rows.map((row) => (
          <Row key={`${row.kind}:${row.id}`} row={row} busy={opening === row.id} onPress={() => open(row)} />
        ))}
      </ul>
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
    <li data-forms-row className="relative flex flex-col">
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

