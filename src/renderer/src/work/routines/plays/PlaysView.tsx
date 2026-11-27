import { useState } from "react";
import type { PlayRow, StarterPlay } from "@shared/contract-work-routines";
import { HostLinkLine, useHostLinkDown } from "../../shell/hostLinkDown";
import { Pencil, Plus } from "../../../chrome/icons";
import { Button } from "../../../components/ui/button";
import { Item, ItemButton } from "../../../components/ui/item";
import { reveal } from "../../../components/ui/reveal";
import { Region } from "../../../components/bones";
import { Spinner } from "../../../components/ui/spinner";
import { loadToast } from "../../../components/ui/toaster";
import { cn } from "../../../lib/cn";
import { useEnvironments } from "../../../lib/connection";
import { headAsk } from "../../../lib/headAsk";
import { nameInLine } from "../../../lib/hostWords";
import { useLinkMay } from "../../../lib/linkMay";
import { EmptyState } from "../../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "../../views/registry";
import { ViewStateLine } from "../../views/ViewStateLine";
import { TruncateTip } from "../../../components/tip";
import { startPlay, usePlays } from "./data";
import { PlayDialog, type PlaySource } from "./PlayDialog";
import { RunDialog } from "./RunDialog";
import { startersLeft, takesLine } from "./model";

/** Who can, over an empty list this window's key may not add to: said by the act, since nothing was changed. */
const addedElsewhere = (host: string): string => `Add plays from a computer that manages ${nameInLine(host)}`;

/**
 * A Work workspace's Plays (docs/agents/work-plays.md): the work he repeats
 * in this job, each one press from a thread. A play that takes nothing
 * starts on its row's press; one that takes something asks for it first.
 * An agent's proposals follow, for him to add or let go, then the sector's
 * starters he has not added, offered and never added by themselves. A key
 * that may not save plays on the host (its admin rule) sees the plays and
 * runs them; New, Edit, the proposals and the starters are not drawn.
 */

// The header's New play asks the view to open the dialog: a press made while the view still loads is answered when it mounts.
const newPlay = headAsk();

export function Head({ env }: WorkViewProps) {
  newPlay.useHead();
  const linkDown = useHostLinkDown(env);
  if (!useLinkMay(env, "work.routines.playSave")) return null;
  return (
    <Button variant="ghost" size="sm" disabled={!!linkDown} onClick={newPlay.ask}>
      <Plus />
      New play
    </Button>
  );
}

export function View({ env, workspace, sector }: WorkViewProps) {
  const [load, retry] = usePlays(env, workspace.id);
  // His Retry spins in place, the failure kept, until the read answers.
  const [retrying, setRetrying] = useState(false);
  const again = (): void => {
    setRetrying(true);
    void retry().finally(() => setRetrying(false));
  };
  const [dialog, setDialog] = useState<PlaySource | null>(null);
  const [run, setRun] = useState<PlayRow | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const maySave = useLinkMay(env, "work.routines.playSave");
  const mayStart = useLinkMay(env, "work.routines.playStart");
  const host = useEnvironments().find((e) => e.id === env)?.name ?? "this host";
  const linkDown = useHostLinkDown(env);
  newPlay.useAnswer(() => !linkDown && setDialog({ kind: "new" }));

  if (linkDown) return <HostLinkLine word={linkDown} retryHost={env} />;
  // New play is the header's press in every state the view draws, so its dialog stands beside the failure and the wait too.
  const playDialog = dialog ? <PlayDialog key={dialog.kind === "edit" ? dialog.row.id : dialog.kind === "starter" ? dialog.starter.key : dialog.kind} env={env} workspaceId={workspace.id} source={dialog} onClose={() => setDialog(null)} /> : null;

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

  const lists = (value: readonly PlayRow[], failed: string | undefined) => {
    const proposed = maySave ? value.filter((p) => p.proposed) : [];
    const plays = value.filter((p) => !p.proposed);
    const starters = maySave ? startersLeft(sector, value) : [];
    return plays.length + proposed.length + starters.length === 0 ? (
      maySave ? (
        <EmptyState title="No plays yet" action={{ label: "New play", onClick: () => setDialog({ kind: "new" }) }} />
      ) : (
        <EmptyState title="No plays yet" line={addedElsewhere(host)} />
      )
    ) : (
      <div className="h-full min-h-0 overflow-x-hidden overflow-y-auto">
        {failed ? (
          // The cause cut to one line reads whole in the line's tip (as Forms').
          <TruncateTip text={failed}>
            <div data-state-tip="">
              <ViewStateLine word="Plays did not load" detail={failed} onRetry={retry} />
            </div>
          </TruncateTip>
        ) : null}
        <div className="mx-auto flex max-w-[672px] flex-col gap-6 px-4 py-4">
          {plays.length ? (
            <Section>
              {plays.map((p) => (
                <Row
                  key={p.id}
                  name={p.name}
                  line={p.takes.length ? takesLine(p.takes) : null}
                  busy={starting === p.id}
                  disabled={starting !== null}
                  onPress={mayStart ? () => start(p) : undefined}
                  onEdit={maySave ? () => setDialog({ kind: "edit", row: p }) : undefined}
                />
              ))}
            </Section>
          ) : null}
          {proposed.length ? (
            <Section title="Proposed">
              {proposed.map((p) => (
                <Row key={p.id} name={p.name} line={p.takes.length ? takesLine(p.takes) : null} onPress={() => setDialog({ kind: "edit", row: p })} />
              ))}
            </Section>
          ) : null}
          {starters.length ? (
            <Section title="Starters">
              {starters.map((s: StarterPlay) => (
                <Row key={s.key} name={s.name} line={s.takes.length ? takesLine(s.takes) : null} onPress={() => setDialog({ kind: "starter", starter: s })} />
              ))}
            </Section>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <>
      <Region loading={load.status === "loading"} label="Loading plays" className="h-full" bones={PlaysBones}>
        {load.status === "loading" ? null : load.status === "error" ? <EmptyState title="Plays did not load" line={load.error} action={{ label: "Retry", onClick: again, busy: retrying }} /> : lists(load.value, load.failed)}
      </Region>
      {playDialog}
      {run ? <RunDialog key={run.id} env={env} workspaceId={workspace.id} play={run} onClose={() => setRun(null)} /> : null}
    </>
  );
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title ?? "Plays"} className="flex flex-col gap-1">
      {/* On the rows' title edge: their 8px inset and the item's 1px border. */}
      {title ? <h2 className="px-[9px] text-xs font-medium text-muted-foreground">{title}</h2> : null}
      <ul className="flex flex-col gap-px">{children}</ul>
    </section>
  );
}

/**
 * A play's row; with no press (a key that may not start it) its words alone. A play that takes nothing has no second
 * line: its name sits centred in a two-line row's height, so the list keeps one rhythm.
 */
function Row({ name, line, busy, disabled, onPress, onEdit }: { name: string; line: string | null; busy?: boolean; disabled?: boolean; onPress?: () => void; onEdit?: () => void }) {
  const words = (
    <>
      <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
      {line ? <span className="truncate text-xs text-muted-foreground">{line}</span> : null}
    </>
  );
  const shape = cn("flex-col flex-nowrap items-stretch gap-0.5 px-2 py-1.5", !line && "min-h-[52px] justify-center", onEdit && "pr-20");
  return (
    <li className="group/row relative flex flex-col">
      {onPress ? (
        <ItemButton disabled={disabled} onClick={onPress} className={shape}>
          {words}
        </ItemButton>
      ) : (
        <Item className={shape}>{words}</Item>
      )}
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

/** Three plays, one that takes nothing: the list's bones, the rows at rest with no press. */
const SAMPLE_PLAYS: readonly { name: string; line: string | null }[] = [
  { name: "Answer a parent's email", line: "Takes a mail" },
  { name: "Weekly staff schedule", line: null },
  { name: "Tournament recap post", line: "Takes a date and a project" },
];

function PlaysBones() {
  return (
    <div className="mx-auto flex max-w-[672px] flex-col gap-6 px-4 py-4">
      <Section>
        {SAMPLE_PLAYS.map((p) => (
          <Row key={p.name} name={p.name} line={p.line} />
        ))}
      </Section>
    </div>
  );
}
