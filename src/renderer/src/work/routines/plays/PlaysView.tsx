import { useEffect, useState, useSyncExternalStore } from "react";
import type { PlayRow, StarterPlay } from "@shared/contract-work-routines";
import { Pencil, Plus } from "../../../chrome/icons";
import { Button } from "../../../components/ui/button";
import { ItemButton } from "../../../components/ui/item";
import { reveal } from "../../../components/ui/reveal";
import { Skeleton } from "../../../components/ui/skeleton";
import { Spinner } from "../../../components/ui/spinner";
import { loadToast } from "../../../components/ui/toaster";
import { cn } from "../../../lib/cn";
import { EmptyState } from "../../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "../../views/registry";
import { startPlay, usePlays } from "./data";
import { PlayDialog, type PlaySource } from "./PlayDialog";
import { RunDialog } from "./RunDialog";
import { startersLeft, takesLine } from "./model";

/**
 * A Work workspace's Plays (docs/agents/work-plays.md): the work he repeats
 * in this job, each one press from a thread. A play that takes nothing
 * starts on its row's press; one that takes something asks for it first.
 * An agent's proposals follow, for him to add or let go, then the sector's
 * starters he has not added, offered and never added by themselves.
 */

// The header's New play asks the view to open the dialog.
const newAsks = new Set<() => void>();
let newAsked = 0;
const askNew = () => {
  newAsked++;
  for (const fn of newAsks) fn();
};

export function Head(_props: WorkViewProps) {
  return (
    <Button variant="ghost" size="sm" onClick={askNew}>
      <Plus />
      New play
    </Button>
  );
}

export function View({ env, workspace, sector }: WorkViewProps) {
  const [load, retry] = usePlays(env, workspace.id);
  const [dialog, setDialog] = useState<PlaySource | null>(null);
  const [run, setRun] = useState<PlayRow | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const asked = useSyncExternalStore(
    (fn) => (newAsks.add(fn), () => newAsks.delete(fn)),
    () => newAsked,
  );
  const [seen, setSeen] = useState(asked);
  useEffect(() => {
    if (asked !== seen) {
      setSeen(asked);
      setDialog({ kind: "new" });
    }
  }, [asked, seen]);

  if (load.status === "loading") return <PlaysSkeleton />;
  if (load.status === "error") return <EmptyState title="Plays did not load" line={load.error} action={{ label: "Retry", onClick: retry }} />;
  const proposed = load.value.filter((p) => p.proposed);
  const plays = load.value.filter((p) => !p.proposed);
  const starters = startersLeft(sector, load.value);

  const start = (play: PlayRow) => {
    if (play.takes.length) return setRun(play);
    setStarting(play.id);
    startPlay(env, play.id, {}).then(
      () => setStarting(null),
      (err: Error) => {
        setStarting(null);
        void loadToast().then((toast) => toast.error(err.message));
      },
    );
  };

  return (
    <>
      {load.value.length === 0 && starters.length === 0 ? (
        <EmptyState title="No plays yet" action={{ label: "New play", onClick: () => setDialog({ kind: "new" }) }} />
      ) : (
        <div className="h-full min-h-0 overflow-x-hidden overflow-y-auto">
          <div className="mx-auto flex max-w-[672px] flex-col gap-6 px-4 py-4">
            {plays.length ? (
              <Section>
                {plays.map((p) => (
                  <Row
                    key={p.id}
                    name={p.name}
                    line={takesLine(p.takes)}
                    busy={starting === p.id}
                    disabled={starting !== null}
                    onPress={() => start(p)}
                    onEdit={() => setDialog({ kind: "edit", row: p })}
                  />
                ))}
              </Section>
            ) : null}
            {proposed.length ? (
              <Section title="Proposed">
                {proposed.map((p) => (
                  <Row key={p.id} name={p.name} line={takesLine(p.takes)} onPress={() => setDialog({ kind: "edit", row: p })} />
                ))}
              </Section>
            ) : null}
            {starters.length ? (
              <Section title="Starters">
                {starters.map((s: StarterPlay) => (
                  <Row key={s.key} name={s.name} line={takesLine(s.takes)} onPress={() => setDialog({ kind: "starter", starter: s })} />
                ))}
              </Section>
            ) : null}
          </div>
        </div>
      )}
      {dialog ? <PlayDialog key={dialog.kind === "edit" ? dialog.row.id : dialog.kind === "starter" ? dialog.starter.key : dialog.kind} env={env} workspaceId={workspace.id} source={dialog} onClose={() => setDialog(null)} /> : null}
      {run ? <RunDialog key={run.id} env={env} workspaceId={workspace.id} play={run} onClose={() => setRun(null)} /> : null}
    </>
  );
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title ?? "Plays"} className="flex flex-col gap-1">
      {title ? <h2 className="px-2 text-xs font-medium text-muted-foreground">{title}</h2> : null}
      <ul className="flex flex-col gap-px">{children}</ul>
    </section>
  );
}

function Row({ name, line, busy, disabled, onPress, onEdit }: { name: string; line: string; busy?: boolean; disabled?: boolean; onPress: () => void; onEdit?: () => void }) {
  return (
    <li className="group/row relative flex flex-col">
      <ItemButton disabled={disabled} onClick={onPress} className={cn("flex-col items-stretch gap-0.5 px-2 py-1.5", onEdit && "pr-20")}>
        <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{line}</span>
      </ItemButton>
      {busy ? (
        <span className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner aria-hidden className="size-3" />
          Starting…
        </span>
      ) : onEdit ? (
        <span className={cn("absolute top-1/2 right-2 -translate-y-1/2", reveal("row", { row: true }))}>
          <Button variant="ghost" size="icon-xs" aria-label={`Edit ${name}`} onClick={onEdit}>
            <Pencil />
          </Button>
        </span>
      ) : null}
    </li>
  );
}

function PlaysSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading plays" className="mx-auto flex max-w-[672px] flex-col gap-3 px-6 py-5">
      {[40, 56, 32].map((w, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
          <Skeleton className="h-3" style={{ width: `${w - 12}%` }} />
        </div>
      ))}
    </div>
  );
}
